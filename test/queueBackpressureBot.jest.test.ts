import {
  QueueBackpressureBot,
  thresholdsFromQueues,
} from "../src/services/eventBus/queueBackpressureBot";
import type { AlertBotConfig } from "../src/services/eventBus/config";
import type {
  AlertDispatcher,
  BackpressureAlert,
  QueueDepthSample,
} from "../src/services/eventBus/types";

const CONFIG: AlertBotConfig = {
  threshold: 1000,
  criticalThreshold: 5000,
  cooldownMs: 15 * 60 * 1000,
  totalScopeName: "event-bus-total",
  alertOnTotal: true,
  recoveryRatio: 0.5,
  resolveOnRecovery: true,
};

function sample(
  name: string,
  pending: number,
  overrides: Partial<QueueDepthSample> = {},
): QueueDepthSample {
  return {
    name,
    pool: overrides.pool ?? "celery-webhook",
    transport: overrides.transport ?? "amqp",
    pending,
    unacked: null,
    consumers: 2,
    oldestPendingAgeSeconds: null,
    acceptingMessages: true,
    observedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function recordingDispatcher() {
  const triggered: BackpressureAlert[] = [];
  const resolved: BackpressureAlert[] = [];
  const dispatcher: AlertDispatcher = {
    trigger: async (alert) => {
      triggered.push(alert);
    },
    resolve: async (alert) => {
      resolved.push(alert);
    },
  };
  return { dispatcher, triggered, resolved };
}

describe("QueueBackpressureBot", () => {
  let clock: number;

  beforeEach(() => {
    clock = Date.parse("2026-01-01T00:00:00.000Z");
  });

  it("stays quiet while every queue is under the 1,000 message threshold", async () => {
    const { dispatcher, triggered } = recordingDispatcher();
    const bot = new QueueBackpressureBot({
      config: CONFIG,
      dispatcher,
      now: () => clock,
    });

    const result = await bot.evaluate([sample("celery:celery", 999)]);

    expect(triggered).toHaveLength(0);
    expect(result.totalPending).toBe(999);
    expect(result.levels).toEqual({
      "celery:celery": "ok",
      "event-bus-total": "ok",
    });
    expect(result.alerts).toHaveLength(0);
  });

  it("raises a Slack warning when a queue crosses 1,000 unhandled messages", async () => {
    const { dispatcher, triggered, resolved } = recordingDispatcher();
    const bot = new QueueBackpressureBot({
      config: CONFIG,
      dispatcher,
      now: () => clock,
    });

    const result = await bot.evaluate([
      sample("celery:webhook.retry", 1000),
      sample("celery:celery", 0),
    ]);

    const queueAlert = triggered.find(
      (a) => a.scope === "celery:webhook.retry",
    );
    expect(queueAlert).toMatchObject({
      level: "warning",
      kind: "trigger",
      pending: 1000,
      threshold: 1000,
      overshootPercent: 100,
      pool: "celery-webhook",
    });

    // 1,000 pending in one queue also trips the aggregate scope.
    const totalAlert = triggered.find((a) => a.scope === "event-bus-total");
    expect(totalAlert).toMatchObject({ level: "warning", pending: 1000 });

    expect(resolved).toHaveLength(0);
    expect(result.criticalScopes).toEqual([]);
  });

  it("suppresses repeat notifications until the cooldown elapses, then reminds", async () => {
    const { dispatcher, triggered } = recordingDispatcher();
    const bot = new QueueBackpressureBot({
      config: CONFIG,
      dispatcher,
      now: () => clock,
    });

    await bot.evaluate([sample("celery:celery", 1500)]);
    expect(triggered.filter((a) => a.kind === "trigger")).toHaveLength(2);

    clock += 60_000;
    await bot.evaluate([sample("celery:celery", 1600)]);
    expect(triggered.filter((a) => a.kind === "reminder")).toHaveLength(0);

    clock += CONFIG.cooldownMs;
    await bot.evaluate([sample("celery:celery", 1700)]);
    const reminders = triggered.filter((a) => a.kind === "reminder");
    expect(reminders).toHaveLength(2);
    expect(reminders[0]?.pending).toBe(1700);
  });

  it("escalates an open warning to critical immediately", async () => {
    const { dispatcher, triggered } = recordingDispatcher();
    const bot = new QueueBackpressureBot({
      config: CONFIG,
      dispatcher,
      now: () => clock,
    });

    await bot.evaluate([sample("celery:celery", 1500)]);
    clock += 1_000;
    const result = await bot.evaluate([sample("celery:celery", 6000)]);

    const critical = triggered.filter((a) => a.level === "critical");
    expect(critical).toHaveLength(2);
    expect(critical[0]?.kind).toBe("trigger");
    expect(critical[0]?.pending).toBe(6000);
    expect(result.criticalScopes).toContain("celery:celery");
  });

  it("holds the incident open inside the hysteresis band and resolves below it", async () => {
    const { dispatcher, triggered, resolved } = recordingDispatcher();
    const bot = new QueueBackpressureBot({
      config: CONFIG,
      dispatcher,
      now: () => clock,
    });

    await bot.evaluate([sample("celery:celery", 2000)]);
    expect(triggered).toHaveLength(2);

    // 750 is under the threshold but above 1000 * 0.5 — hold, do not resolve.
    clock += CONFIG.cooldownMs;
    const held = await bot.evaluate([sample("celery:celery", 750)]);
    expect(held.levels["celery:celery"]).toBe("warning");
    expect(resolved).toHaveLength(0);
    expect(triggered).toHaveLength(2);

    // Below the recovery mark the incident closes.
    const drained = await bot.evaluate([sample("celery:celery", 100)]);
    expect(drained.levels["celery:celery"]).toBe("ok");
    expect(drained.levels["event-bus-total"]).toBe("ok");
    const queueResolve = resolved.find((a) => a.scope === "celery:celery");
    expect(queueResolve).toMatchObject({
      level: "ok",
      kind: "resolve",
      pending: 100,
    });
    expect(resolved.filter((a) => a.scope === "event-bus-total")).toHaveLength(
      1,
    );
  });

  it("can re-open an incident after a resolve", async () => {
    const { dispatcher, triggered, resolved } = recordingDispatcher();
    const bot = new QueueBackpressureBot({
      config: CONFIG,
      dispatcher,
      now: () => clock,
    });

    await bot.evaluate([sample("celery:celery", 2000)]);
    await bot.evaluate([sample("celery:celery", 10)]);
    await bot.evaluate([sample("celery:celery", 3000)]);

    expect(resolved.filter((a) => a.scope === "celery:celery")).toHaveLength(1);
    expect(
      triggered.filter(
        (a) => a.scope === "celery:celery" && a.kind === "trigger",
      ),
    ).toHaveLength(2);
  });

  it("honours per-queue threshold overrides", async () => {
    const { dispatcher, triggered } = recordingDispatcher();
    const bot = new QueueBackpressureBot({
      config: CONFIG,
      dispatcher,
      thresholds: new Map([["celery:celery", { warning: 100, critical: 200 }]]),
      now: () => clock,
    });

    await bot.evaluate([
      sample("celery:celery", 150),
      sample("celery:webhook.retry", 150),
    ]);

    expect(triggered.find((a) => a.scope === "celery:celery")).toMatchObject({
      threshold: 100,
      level: "warning",
    });
    // The un-overridden queue stays under its 1,000 threshold.
    expect(
      triggered.find((a) => a.scope === "celery:webhook.retry"),
    ).toBeUndefined();
  });

  it("attaches the worst queues, probe errors and desired replicas to an alert", async () => {
    const { dispatcher, triggered } = recordingDispatcher();
    const bot = new QueueBackpressureBot({
      config: CONFIG,
      dispatcher,
      resolveDesiredReplicas: (pool) => (pool === "celery-webhook" ? 6 : null),
      now: () => clock,
    });

    await bot.evaluate(
      [
        sample("celery:celery", 10),
        sample("celery:webhook.retry", 3000),
        sample("celery:webhook.dead", 1500),
      ],
      ["redis:dlq probe timed out"],
    );

    const alert = triggered.find((a) => a.scope === "celery:webhook.retry");
    expect(alert?.desiredReplicas).toBe(6);
    expect(alert?.probeErrors).toEqual(["redis:dlq probe timed out"]);
    // A queue-scoped alert describes the offending queue.
    expect(alert?.queues.map((q) => q.name)).toEqual(["celery:webhook.retry"]);

    // The aggregate scope carries the full breakdown, worst first.
    const total = triggered.find((a) => a.scope === "event-bus-total");
    expect(total?.queues.map((q) => q.pending)).toEqual([3000, 1500, 10]);
  });

  it("survives a dispatcher failure and keeps evaluating", async () => {
    const bot = new QueueBackpressureBot({
      config: CONFIG,
      dispatcher: {
        trigger: async () => {
          throw new Error("slack 500");
        },
        resolve: async () => undefined,
      },
      now: () => clock,
    });

    await expect(
      bot.evaluate([sample("celery:celery", 2000)]),
    ).resolves.toBeDefined();
    expect(bot.getLevels()["celery:celery"]).toBe("warning");
  });

  it("tracks incident bookkeeping and can forget a scope", async () => {
    const { dispatcher } = recordingDispatcher();
    const bot = new QueueBackpressureBot({
      config: CONFIG,
      dispatcher,
      now: () => clock,
    });

    await bot.evaluate([sample("celery:celery", 1200)]);
    await bot.evaluate([sample("celery:celery", 4800)]);

    const states = bot.getScopeStates();
    expect(states["celery:celery"]).toMatchObject({
      level: "warning",
      lastPending: 4800,
      peakPending: 4800,
    });

    bot.forget("celery:celery");
    expect(bot.getScopeStates()["celery:celery"]).toBeUndefined();
  });

  it("does not dispatch when dispatching is disabled", async () => {
    const { dispatcher, triggered } = recordingDispatcher();
    const bot = new QueueBackpressureBot({
      config: CONFIG,
      dispatcher,
      dispatch: false,
      now: () => clock,
    });

    const result = await bot.evaluate([sample("celery:celery", 5000)]);

    expect(triggered).toHaveLength(0);
    expect(result.alerts.length).toBeGreaterThan(0);
  });
});

describe("thresholdsFromQueues", () => {
  it("only records queues that deviate from the defaults", () => {
    const map = thresholdsFromQueues(
      [
        { name: "a" },
        { name: "b", warningThreshold: 50, criticalThreshold: 500 },
        { name: "c", criticalThreshold: 100 },
      ],
      { warning: 1000, critical: 5000 },
    );

    expect([...map.keys()]).toEqual(["b", "c"]);
    expect(map.get("b")).toEqual({ warning: 50, critical: 500 });
    // critical is never allowed to fall below warning
    expect(map.get("c")).toEqual({ warning: 1000, critical: 1000 });
  });
});
