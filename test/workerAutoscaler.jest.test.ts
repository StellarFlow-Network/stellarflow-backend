import { jest } from "@jest/globals";
import { WorkerAutoscaler } from "../src/services/eventBus/workerAutoscaler";
import {
  NoopScaleProvider,
  createScaleProvider,
} from "../src/services/eventBus/scaleProviders";
import type { AutoscalerConfig } from "../src/services/eventBus/config";
import type {
  QueueDepthSample,
  ScaleProvider,
} from "../src/services/eventBus/types";

const CONFIG: AutoscalerConfig = {
  enabled: true,
  minReplicas: 1,
  maxReplicas: 10,
  targetMessagesPerReplica: 250,
  maxScaleStep: 5,
  cooldownMs: 5 * 60 * 1000,
  scaleDownStabilizationMs: 10 * 60 * 1000,
  scaleDownThreshold: 100,
  pools: ["celery-webhook"],
};

function sample(name: string, pool: string, pending: number): QueueDepthSample {
  return {
    name,
    pool,
    transport: "amqp",
    pending,
    unacked: null,
    consumers: 2,
    oldestPendingAgeSeconds: null,
    acceptingMessages: true,
    observedAt: "2026-01-01T00:00:00.000Z",
  };
}

class FakeProvider implements ScaleProvider {
  readonly name = "fake";
  readonly replicas = new Map<string, number>();
  readonly writes: Array<{ pool: string; replicas: number }> = [];
  failNextWrite: string | null = null;

  constructor(initial: Record<string, number>) {
    this.replicas = new Map(Object.entries(initial));
  }

  async getReplicaCount(pool: string): Promise<number | null> {
    return this.replicas.get(pool) ?? null;
  }

  async setReplicaCount(pool: string, replicas: number): Promise<void> {
    if (this.failNextWrite) {
      const message = this.failNextWrite;
      this.failNextWrite = null;
      throw new Error(message);
    }
    this.writes.push({ pool, replicas });
    this.replicas.set(pool, replicas);
  }
}

describe("WorkerAutoscaler", () => {
  let clock: number;

  beforeEach(() => {
    clock = Date.parse("2026-01-01T00:00:00.000Z");
  });

  it("derives replicas from queue depth and clamps to the min/max band", () => {
    const autoscaler = new WorkerAutoscaler({ config: CONFIG });

    expect(autoscaler.desiredReplicasFor(0)).toBe(1);
    expect(autoscaler.desiredReplicasFor(250)).toBe(1);
    expect(autoscaler.desiredReplicasFor(501)).toBe(3);
    expect(autoscaler.desiredReplicasFor(999_999)).toBe(10);
  });

  it("scales up when the backlog outgrows the current fleet", async () => {
    const provider = new FakeProvider({ "celery-webhook": 2 });
    const autoscaler = new WorkerAutoscaler({
      config: CONFIG,
      provider,
      now: () => clock,
    });
    await autoscaler.refreshReplicaCount("celery-webhook");

    // 2,000 messages / 250 per replica = 8, capped at maxScaleStep 5 above 2.
    const evaluation = await autoscaler.evaluate([
      sample("celery:webhook.retry", "celery-webhook", 2000),
    ]);

    expect(evaluation.desired["celery-webhook"]).toBe(8);
    expect(evaluation.decisions[0]).toMatchObject({
      pool: "celery-webhook",
      action: "scale_up",
      from: 2,
      to: 7,
      limitedBy: "max-scale-step",
    });

    const applied = await autoscaler.apply(evaluation);
    expect(applied).toEqual([{ pool: "celery-webhook", applied: true }]);
    expect(provider.writes).toEqual([{ pool: "celery-webhook", replicas: 7 }]);
  });

  it("sums every queue in a pool when computing depth", async () => {
    const provider = new FakeProvider({ "celery-webhook": 1 });
    const autoscaler = new WorkerAutoscaler({
      config: CONFIG,
      provider,
      now: () => clock,
    });
    await autoscaler.refreshReplicaCount("celery-webhook");

    const evaluation = await autoscaler.evaluate([
      sample("celery:webhook.retry", "celery-webhook", 1500),
      sample("celery:webhook.dead", "celery-webhook", 1500),
    ]);

    // (1500 + 1500) / 250 = 12 desired, clamped to maxReplicas 10.
    expect(evaluation.desired["celery-webhook"]).toBe(10);
    expect(evaluation.decisions[0]?.to).toBe(6);
  });

  it("defers scale-down until the backlog has been drained for the stabilization window", async () => {
    const provider = new FakeProvider({ "celery-webhook": 6 });
    const autoscaler = new WorkerAutoscaler({
      config: CONFIG,
      provider,
      now: () => clock,
    });
    await autoscaler.refreshReplicaCount("celery-webhook");

    const drained = [sample("celery:webhook.retry", "celery-webhook", 10)];

    const first = await autoscaler.evaluate(drained);
    expect(first.decisions[0]).toMatchObject({
      action: "none",
      limitedBy: "scale-down-stabilization",
    });

    clock += CONFIG.scaleDownStabilizationMs;
    const settled = await autoscaler.evaluate(drained);
    expect(settled.decisions[0]).toMatchObject({
      action: "scale_down",
      from: 6,
      to: 1,
    });
  });

  it("resets the stabilization window whenever the backlog climbs back up", async () => {
    const provider = new FakeProvider({ "celery-webhook": 6 });
    const autoscaler = new WorkerAutoscaler({
      config: CONFIG,
      provider,
      now: () => clock,
    });
    await autoscaler.refreshReplicaCount("celery-webhook");

    await autoscaler.evaluate([sample("q", "celery-webhook", 10)]);
    clock += CONFIG.scaleDownStabilizationMs - 1000;
    await autoscaler.evaluate([sample("q", "celery-webhook", 500)]);
    clock += 2000;
    const decision = await autoscaler.evaluate([
      sample("q", "celery-webhook", 10),
    ]);

    expect(decision.decisions[0]?.action).toBe("none");
    expect(decision.decisions[0]?.limitedBy).toBe("scale-down-stabilization");
  });

  it("respects the per-pool scale cooldown", async () => {
    const provider = new FakeProvider({ "celery-webhook": 2 });
    const autoscaler = new WorkerAutoscaler({
      config: CONFIG,
      provider,
      now: () => clock,
    });
    await autoscaler.refreshReplicaCount("celery-webhook");
    const samples = [sample("q", "celery-webhook", 5000)];

    const first = await autoscaler.evaluate(samples);
    await autoscaler.apply(first);
    expect(provider.writes).toHaveLength(1);

    clock += 1000;
    provider.replicas.set("celery-webhook", 2);
    await autoscaler.refreshReplicaCount("celery-webhook");
    const second = await autoscaler.evaluate(samples);
    const applied = await autoscaler.apply(second);

    expect(applied).toEqual([
      { pool: "celery-webhook", applied: false, error: "cooldown" },
    ]);
    expect(provider.writes).toHaveLength(1);

    clock += CONFIG.cooldownMs;
    provider.replicas.set("celery-webhook", 2);
    await autoscaler.refreshReplicaCount("celery-webhook");
    const third = await autoscaler.evaluate(samples);
    await autoscaler.apply(third);
    expect(provider.writes).toHaveLength(2);
  });

  it("stays advisory when the autoscaler is disabled", async () => {
    const provider = new FakeProvider({ "celery-webhook": 1 });
    const autoscaler = new WorkerAutoscaler({
      config: { ...CONFIG, enabled: false },
      provider,
      now: () => clock,
    });
    await autoscaler.refreshReplicaCount("celery-webhook");

    const evaluation = await autoscaler.evaluate([
      sample("q", "celery-webhook", 9000),
    ]);
    const applied = await autoscaler.apply(evaluation);

    expect(evaluation.enabled).toBe(false);
    expect(evaluation.desired["celery-webhook"]).toBe(10);
    expect(applied).toEqual([{ pool: "celery-webhook", applied: false }]);
    expect(provider.writes).toHaveLength(0);
  });

  it("adopts a baseline instead of guessing a delta when the provider is unknown", async () => {
    const autoscaler = new WorkerAutoscaler({
      config: { ...CONFIG, pools: [] },
      provider: null,
      now: () => clock,
    });

    const evaluation = await autoscaler.evaluate([
      sample("q", "celery-webhook", 2500),
    ]);

    expect(evaluation.decisions[0]).toMatchObject({
      action: "none",
      from: null,
      to: 10,
      limitedBy: "unknown-current",
    });
  });

  it("ignores queues whose probe failed", async () => {
    const provider = new FakeProvider({ "celery-webhook": 3 });
    const autoscaler = new WorkerAutoscaler({
      config: CONFIG,
      provider,
      now: () => clock,
    });
    await autoscaler.refreshReplicaCount("celery-webhook");

    const evaluation = await autoscaler.evaluate([
      { ...sample("q", "celery-webhook", 9999), pending: -1, error: "boom" },
    ]);

    expect(evaluation.desired["celery-webhook"]).toBe(1);
  });

  it("reports a provider failure without throwing", async () => {
    const provider = new FakeProvider({ "celery-webhook": 1 });
    provider.failNextWrite = "docker socket unavailable";
    const autoscaler = new WorkerAutoscaler({
      config: CONFIG,
      provider,
      now: () => clock,
    });
    await autoscaler.refreshReplicaCount("celery-webhook");

    const evaluation = await autoscaler.evaluate([
      sample("q", "celery-webhook", 9000),
    ]);
    const applied = await autoscaler.apply(evaluation);

    expect(applied).toEqual([
      {
        pool: "celery-webhook",
        applied: false,
        error: "docker socket unavailable",
      },
    ]);
    expect(provider.writes).toHaveLength(0);
  });

  it("keeps the last known replica count when the provider read fails", async () => {
    const provider: ScaleProvider = {
      name: "flaky",
      getReplicaCount: jest.fn(async () => {
        throw new Error("timeout");
      }),
      setReplicaCount: jest.fn(async () => undefined),
    };
    const autoscaler = new WorkerAutoscaler({
      config: CONFIG,
      provider,
      now: () => clock,
    });

    expect(await autoscaler.refreshReplicaCount("celery-webhook")).toBeNull();
  });
});

describe("scale providers", () => {
  it("NoopScaleProvider records intent without mutating anything", async () => {
    const provider = new NoopScaleProvider();
    expect(await provider.getReplicaCount("celery-webhook")).toBeNull();
    await provider.setReplicaCount("celery-webhook", 4);
    expect(provider.calls).toEqual([{ pool: "celery-webhook", replicas: 4 }]);
  });

  it("createScaleProvider honours the provider name", () => {
    expect(createScaleProvider("noop")?.name).toBe("noop");
    expect(createScaleProvider("docker", {})?.name).toBe("docker");
    expect(createScaleProvider("kubernetes", {})?.name).toBe("kubernetes");
    expect(
      createScaleProvider("webhook", {
        EVENT_BUS_AUTOSCALE_WEBHOOK_URL: "https://scale.internal/hook",
      })?.name,
    ).toBe("webhook");
  });

  it("createScaleProvider returns null for unusable configuration", () => {
    expect(createScaleProvider("webhook", {})).toBeNull();
    expect(createScaleProvider("nomad", {})).toBeNull();
    expect(createScaleProvider(null, {})?.name).toBe("noop");
  });
});
