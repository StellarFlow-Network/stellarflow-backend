import { describe, it, expect, beforeEach, jest } from "@jest/globals";

// The metrics module registers its series on the shared Prometheus registry,
// which lives behind the Prisma-backed metrics middleware. Stub Prisma so the
// orchestrator can be exercised without a database or a generated client.
jest.unstable_mockModule("../src/lib/prisma", () => ({
  default: { _pool: null },
}));

// The service resolves its Redis depth reader from the shared client, which
// is disabled in CI anyway — stub it so this test never opens a socket.
jest.unstable_mockModule("../src/lib/redis", () => ({
  getRedisClient: () => null,
  disconnectRedis: async () => undefined,
}));

const { EventBusService } =
  await import("../src/services/eventBus/eventBusService");
const { QueueDepthCollector } =
  await import("../src/services/eventBus/queueDepthCollector");
const { loadEventBusConfig } = await import("../src/services/eventBus/config");
const { NoopScaleProvider } =
  await import("../src/services/eventBus/scaleProviders");
// The app registry is the one /metrics serves; the prom-client default
// registry is only used to assert the gauges were not also created there.
const promClient = (await import("prom-client")).default;
const { register } = await import("../src/middleware/metrics");

import type {
  AmqpDepthReader,
  BackpressureAlert,
  ScaleProvider,
} from "../src/services/eventBus/types";

function fakeAmqp(counts: Record<string, number>): AmqpDepthReader {
  return {
    checkQueue: async (queue: string) => ({
      messageCount: counts[queue] ?? 0,
      consumerCount: 1,
    }),
  };
}

function recordingScaleProvider(
  replicas: Record<string, number>,
): ScaleProvider {
  const state = new Map(Object.entries(replicas));
  return {
    name: "recording",
    getReplicaCount: async (pool: string) => state.get(pool) ?? null,
    setReplicaCount: async (pool: string, count: number) => {
      state.set(pool, count);
    },
  };
}

function config(env: Record<string, string> = {}) {
  return loadEventBusConfig({
    POLL: "unused",
    ...env,
  } as Record<string, string | undefined>);
}

function collectorWith(counts: Record<string, number>, now?: () => number) {
  return new QueueDepthCollector({
    queues: [
      {
        name: "celery:webhook.retry",
        pool: "celery-webhook",
        transport: "amqp",
        key: "webhook.retry",
      },
      {
        name: "celery:celery",
        pool: "celery-webhook",
        transport: "amqp",
        key: "celery",
      },
    ],
    amqp: fakeAmqp(counts),
    now,
  });
}

describe("EventBusService", () => {
  let clock: number;

  beforeEach(() => {
    clock = Date.parse("2026-01-01T00:00:00.000Z");
  });

  it("runs a full cycle: collect → metrics → alert → autoscale", async () => {
    const triggered: BackpressureAlert[] = [];
    const provider = recordingScaleProvider({ "celery-webhook": 2 });
    const service = new EventBusService({
      config: config({
        EVENT_BUS_AUTOSCALE_ENABLED: "true",
        EVENT_BUS_AUTOSCALE_POOLS: "celery-webhook",
        EVENT_BUS_AUTOSCALE_STABILIZATION_MS: "0",
        EVENT_BUS_AUTOSCALE_COOLDOWN_MS: "0",
      }),
      collector: collectorWith({ "webhook.retry": 2500, celery: 10 }),
      dispatcher: {
        trigger: async (alert) => {
          triggered.push(alert);
        },
        resolve: async () => undefined,
      },
      scaleProvider: provider,
      now: () => clock,
    });

    const cycle = await service.runCycle();

    // 1. Collection
    expect(cycle.totalPending).toBe(2510);
    expect(cycle.samples.map((sample) => sample.name)).toEqual([
      "celery:webhook.retry",
      "celery:celery",
    ]);

    // 2. Metrics
    const scraped = await register.metrics();
    expect(scraped).toContain("event_bus_queue_pending_messages");
    expect(scraped).toContain('queue="celery:webhook.retry"');
    expect(scraped).toContain(
      'event_bus_queue_backlog_ratio{queue="celery:webhook.retry",pool="celery-webhook",transport="amqp"} 2.5',
    );
    expect(scraped).toContain("event_bus_queue_total_pending_messages");
    expect(scraped).toContain("event_bus_backpressure_severity");

    // 3. Alerting — 2,500 > 1,000 warning threshold, per queue and aggregate.
    expect(triggered.map((alert) => alert.scope).sort()).toEqual([
      "celery:webhook.retry",
      "event-bus-total",
    ]);
    expect(triggered[0]?.level).toBe("warning");
    expect(cycle.backpressure.levels["celery:webhook.retry"]).toBe("warning");
    expect(cycle.backpressure.levels["celery:celery"]).toBe("ok");

    // 4. Autoscaling — 2,510 / 250 = 11 desired, clamped to maxReplicas 20,
    //    stepped +5 from 2 replicas.
    expect(cycle.autoscaler.desired["celery-webhook"]).toBe(11);
    expect(cycle.autoscaler.decisions[0]).toMatchObject({
      action: "scale_up",
      from: 2,
      to: 7,
    });
    expect(cycle.appliedScales).toEqual([
      { pool: "celery-webhook", applied: true },
    ]);

    expect(await provider.getReplicaCount("celery-webhook")).toBe(7);
  });

  it("keeps the history bounded and oldest-first", async () => {
    let service: InstanceType<typeof EventBusService>;

    const collector = collectorWith({ "webhook.retry": 5 }, () => clock);
    service = new EventBusService({
      config: config({ EVENT_BUS_HISTORY_SIZE: "2" }),
      collector,
      dispatcher: {
        trigger: async () => undefined,
        resolve: async () => undefined,
      },
      scaleProvider: new NoopScaleProvider(),
      now: () => clock,
    });

    await service.runCycle();
    clock += 1_000;
    await service.runCycle();
    clock += 1_000;
    await service.runCycle();

    const history = service.getHistory();
    expect(history).toHaveLength(2);
    expect(history[0]?.observedAt).toBe(
      new Date(Date.parse("2026-01-01T00:00:01.000Z")).toISOString(),
    );
    expect(history.at(-1)?.observedAt).toBe(
      new Date(Date.parse("2026-01-01T00:00:02.000Z")).toISOString(),
    );
    expect(service.getHistory(1)).toHaveLength(1);
  });

  it("shares one in-flight cycle between concurrent callers", async () => {
    const service = new EventBusService({
      config: config(),
      collector: collectorWith({ "webhook.retry": 3 }),
      dispatcher: {
        trigger: async () => undefined,
        resolve: async () => undefined,
      },
      now: () => clock,
    });

    const [first, second] = await Promise.all([
      service.runCycle(),
      service.runCycle(),
    ]);

    expect(first).toBe(second);
  });

  it("reports a status snapshot for the admin endpoints", async () => {
    const service = new EventBusService({
      config: config(),
      collector: collectorWith({ "webhook.retry": 3 }),
      dispatcher: {
        trigger: async () => undefined,
        resolve: async () => undefined,
      },
      scaleProvider: new NoopScaleProvider(),
      now: () => clock,
    });

    expect(service.getStatus().lastCycle).toBeNull();
    expect(service.isRunning()).toBe(false);

    await service.runCycle();
    const status = service.getStatus();

    expect(status.queueCount).toBe(2);
    expect(status.alert.threshold).toBe(1000);
    expect(status.autoscaler.provider).toBe("noop");
    expect(status.lastCycle?.totalPending).toBe(3);
    expect(status.scopeStates["celery:webhook.retry"]?.level).toBe("ok");
  });

  it("marks a queue with a failed probe as unknown rather than as backlog", async () => {
    const collector = new QueueDepthCollector({
      queues: [
        {
          name: "celery:celery",
          pool: "celery-webhook",
          transport: "amqp",
          key: "celery",
        },
      ],
      amqp: {
        checkQueue: async () => {
          throw new Error("broker down");
        },
      },
    });
    const service = new EventBusService({
      config: config(),
      collector,
      dispatcher: {
        trigger: async () => undefined,
        resolve: async () => undefined,
      },
      now: () => clock,
    });

    const cycle = await service.runCycle();

    expect(cycle.totalPending).toBe(0);
    expect(cycle.probeErrors).toHaveLength(1);
    expect(cycle.samples[0]?.pending).toBe(-1);

    const scraped = await register.metrics();
    // A failed probe must not publish a negative backlog.
    expect(scraped).toContain("event_bus_queue_probe_failures_total");
  });

  it("does not start a polling loop when monitoring is disabled", async () => {
    const service = new EventBusService({
      config: config({ EVENT_BUS_MONITORING_ENABLED: "false" }),
      collector: collectorWith({}),
      dispatcher: {
        trigger: async () => undefined,
        resolve: async () => undefined,
      },
      now: () => clock,
    });

    service.start();

    expect(service.isRunning()).toBe(false);
    expect(service.getStatus().lastCycle).toBeNull();
    await service.stop();
  });

  it("registers series on the registry the /metrics endpoint serves", () => {
    // The whole point of routing through the app registry.
    expect(
      register.getSingleMetricAsString("event_bus_queue_pending_messages"),
    ).toBeDefined();
  });
});

describe("event bus metrics hygiene", () => {
  it("does not leak unregistered metric names into the default registry", () => {
    // Guards against a future refactor creating the gauges twice (once on the
    // default registry, once on the app registry), which silently double-counts.
    expect(
      promClient.register.getSingleMetric("event_bus_queue_pending_messages"),
    ).toBeUndefined();
  });

  it("keeps the label set stable", async () => {
    const metric = await register.getMetricsAsJSON();
    const pending = metric.find(
      (entry: { name: string }) =>
        entry.name === "event_bus_queue_pending_messages",
    );
    expect(pending?.type).toBe("gauge");
    expect(pending?.help).toBe(
      "Messages waiting in an event bus queue (backlog)",
    );
  });
});
