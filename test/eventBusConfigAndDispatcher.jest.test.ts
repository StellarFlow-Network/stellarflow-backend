import { jest } from "@jest/globals";
import {
  DEFAULT_BACKPRESSURE_THRESHOLD,
  buildQueueDescriptors,
  loadEventBusConfig,
} from "../src/services/eventBus/config";
import {
  EventBusAlertDispatcher,
  LoggingAlertDispatcher,
  createAlertDispatcher,
  dedupKey,
} from "../src/services/eventBus/alertDispatcher";
import type { BackpressureAlert } from "../src/services/eventBus/types";

function alert(overrides: Partial<BackpressureAlert> = {}): BackpressureAlert {
  return {
    scope: "celery:webhook.retry",
    pool: "celery-webhook",
    level: "warning",
    pending: 1500,
    threshold: 1000,
    criticalThreshold: 5000,
    overshootPercent: 150,
    kind: "trigger",
    observedAt: "2026-01-01T00:00:00.000Z",
    queues: [
      {
        name: "celery:webhook.retry",
        pool: "celery-webhook",
        transport: "amqp",
        pending: 1500,
        consumers: 2,
        unacked: 3,
      },
    ],
    probeErrors: [],
    desiredReplicas: 6,
    ...overrides,
  };
}

describe("loadEventBusConfig", () => {
  it("defaults to a 1,000 message backpressure threshold with no env set", () => {
    const config = loadEventBusConfig({});

    expect(config.enabled).toBe(true);
    expect(config.pollIntervalMs).toBe(15_000);
    expect(config.alert.threshold).toBe(DEFAULT_BACKPRESSURE_THRESHOLD);
    expect(config.alert.threshold).toBe(1_000);
    expect(config.alert.criticalThreshold).toBe(5_000);
    expect(config.alert.recoveryRatio).toBe(0.5);
    expect(config.autoscaler.enabled).toBe(false);
    expect(config.autoscaler.minReplicas).toBe(1);
    expect(config.autoscaler.maxReplicas).toBe(20);
  });

  it("watches the Celery queues from app/celery_app.py plus the Redis DLQ", () => {
    const queues = buildQueueDescriptors({});

    expect(
      queues.filter((q) => q.transport === "amqp").map((q) => q.key),
    ).toEqual([
      "celery",
      "webhook.retry",
      "webhook.dead",
      "index-shielded-notes",
    ]);
    // Every Celery queue shares one worker pool — the autoscaling unit.
    expect(
      new Set(queues.filter((q) => q.transport === "amqp").map((q) => q.pool)),
    ).toEqual(new Set(["celery-webhook"]));
    expect(queues).toContainEqual({
      name: "redis:dlq",
      pool: "ingestion-dlq",
      transport: "redis-list",
      key: "stellarflow:dlq",
    });
  });

  it("adds extra Redis keys, streams and pub/sub channels", () => {
    const queues = buildQueueDescriptors({
      REDIS_MONITORED_LIST_KEYS: "a,b",
      REDIS_MONITORED_STREAM_KEYS: "events",
      REDIS_MONITORED_PUBSUB_CHANNELS: "ledger",
      DLQ_REDIS_KEY: "custom:dlq",
    });

    expect(queues).toContainEqual({
      name: "redis:list:a",
      pool: "redis-lists",
      transport: "redis-list",
      key: "a",
    });
    expect(queues).toContainEqual({
      name: "redis:stream:events",
      pool: "redis-streams",
      transport: "redis-stream",
      key: "events",
    });
    expect(queues).toContainEqual({
      name: "redis:pubsub:ledger",
      pool: "redis-pubsub",
      transport: "redis-pubsub",
      channel: "ledger",
    });
    expect(queues).toContainEqual({
      name: "redis:dlq",
      pool: "ingestion-dlq",
      transport: "redis-list",
      key: "custom:dlq",
    });
  });

  it("lets EVENT_BUS_QUEUES replace the whole catalogue and skips bad entries", () => {
    const queues = buildQueueDescriptors({
      EVENT_BUS_QUEUES: "a:amqp:celery,b:redis-list:key,broken:telepathy:x",
    });

    expect(queues).toEqual([
      { name: "a", pool: "default", transport: "amqp", key: "celery" },
      { name: "b", pool: "default", transport: "redis-list", key: "key" },
    ]);
  });

  it("parses a pub/sub spec with a channel", () => {
    const queues = buildQueueDescriptors({
      EVENT_BUS_QUEUES: "pubsub:redis-pubsub:ledger",
    });
    expect(queues[0]).toEqual({
      name: "pubsub",
      pool: "default",
      transport: "redis-pubsub",
      channel: "ledger",
    });
  });

  it("ignores malformed and out-of-range values", () => {
    const config = loadEventBusConfig({
      EVENT_BUS_POLL_INTERVAL_MS: "not-a-number",
      EVENT_BUS_BACKPRESSURE_THRESHOLD: "0",
      EVENT_BUS_AUTOSCALE_MAX_REPLICAS: "5",
      EVENT_BUS_AUTOSCALE_MIN_REPLICAS: "9",
    });

    expect(config.pollIntervalMs).toBe(15_000);
    // A zero threshold is rejected in favour of the 1,000 default.
    expect(config.alert.threshold).toBe(1_000);
    // maxReplicas can never end up below minReplicas.
    expect(config.autoscaler.maxReplicas).toBe(9);
  });

  it("reads the alert delivery endpoints", () => {
    const config = loadEventBusConfig({
      SLACK_WEBHOOK_URL: "https://hooks.slack.com/services/T/B/X",
      PAGERDUTY_ROUTING_KEY: "routing-key",
      CELERY_BROKER_URL: "amqp://guest:guest@rabbitmq:5672//",
    });

    expect(config.slackWebhookUrl).toBe(
      "https://hooks.slack.com/services/T/B/X",
    );
    expect(config.pagerdutyRoutingKey).toBe("routing-key");
    expect(config.amqpUrl).toBe("amqp://guest:guest@rabbitmq:5672//");
  });

  it("can disable monitoring and autoscale switches", () => {
    const config = loadEventBusConfig({
      EVENT_BUS_MONITORING_ENABLED: "false",
      EVENT_BUS_AUTOSCALE_ENABLED: "true",
      EVENT_BUS_ALERT_ON_TOTAL: "no",
    });

    expect(config.enabled).toBe(false);
    expect(config.autoscaler.enabled).toBe(true);
    expect(config.alert.alertOnTotal).toBe(false);
  });
});

describe("EventBusAlertDispatcher", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  function stubFetch() {
    const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
    globalThis.fetch = jest.fn(async (url: string, init: { body: unknown }) => {
      calls.push({
        url: String(url),
        body: JSON.parse(String(init.body)) as Record<string, unknown>,
      });
      return new Response("ok", { status: 200 });
    }) as unknown as typeof fetch;
    return calls;
  }

  it("posts a warning to Slack without paging PagerDuty", async () => {
    const calls = stubFetch();
    const dispatcher = new EventBusAlertDispatcher({
      slackWebhookUrl: "https://hooks.slack.com/services/T/B/X",
      pagerdutyRoutingKey: "routing-key",
    });

    await dispatcher.trigger(alert());

    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("https://hooks.slack.com/services/T/B/X");
    expect(String(calls[0]?.body.text)).toContain("1500 unhandled messages");
  });

  it("pages PagerDuty on a critical backlog with a stable dedup key", async () => {
    const calls = stubFetch();
    const dispatcher = new EventBusAlertDispatcher({
      slackWebhookUrl: "https://hooks.slack.com/services/T/B/X",
      pagerdutyRoutingKey: "routing-key",
    });

    await dispatcher.trigger(
      alert({ level: "critical", pending: 9000, kind: "trigger" }),
    );

    const pagerduty = calls.find((call) => call.url.includes("pagerduty"));
    expect(pagerduty?.body).toMatchObject({
      routing_key: "routing-key",
      event_action: "trigger",
      dedup_key: "stellarflow-queue-backpressure-celery:webhook.retry",
    });
    expect(pagerduty?.body.payload).toMatchObject({
      severity: "critical",
      source: "stellarflow-event-bus",
    });
  });

  it("re-uses the same dedup key for the resolve so the incident closes", async () => {
    const calls = stubFetch();
    const dispatcher = new EventBusAlertDispatcher({
      pagerdutyRoutingKey: "routing-key",
    });

    await dispatcher.trigger(alert({ level: "critical" }));
    await dispatcher.resolve(
      alert({ level: "ok", kind: "resolve", pending: 5 }),
    );

    const resolve = calls.at(-1);
    expect(resolve?.body.event_action).toBe("resolve");
    expect(dedupKey(alert())).toBe(resolve?.body.dedup_key);
  });

  it("swallows a Slack outage so monitoring keeps running", async () => {
    globalThis.fetch = jest.fn(async () => {
      throw new Error("socket hang up");
    }) as unknown as typeof fetch;
    const dispatcher = new EventBusAlertDispatcher({
      slackWebhookUrl: "https://hooks.slack.com/services/T/B/X",
    });

    await expect(dispatcher.trigger(alert())).resolves.toBeUndefined();
  });

  it("reports a non-2xx PagerDuty response without throwing", async () => {
    globalThis.fetch = jest.fn(
      async () => new Response("bad routing key", { status: 400 }),
    ) as unknown as typeof fetch;
    const dispatcher = new EventBusAlertDispatcher({
      pagerdutyRoutingKey: "bad",
    });

    await expect(
      dispatcher.trigger(alert({ level: "critical" })),
    ).resolves.toBeUndefined();
  });
});

describe("createAlertDispatcher", () => {
  it("falls back to logging when nothing is configured", () => {
    expect(createAlertDispatcher({})).toBeInstanceOf(LoggingAlertDispatcher);
    expect(createAlertDispatcher({ enabled: false })).toBeInstanceOf(
      LoggingAlertDispatcher,
    );
  });

  it("uses Slack + PagerDuty when either endpoint is configured", () => {
    expect(
      createAlertDispatcher({ pagerdutyRoutingKey: "key" }),
    ).toBeInstanceOf(EventBusAlertDispatcher);
  });

  it("the logging dispatcher satisfies the AlertDispatcher contract", async () => {
    const dispatcher = new LoggingAlertDispatcher();
    await expect(dispatcher.trigger(alert())).resolves.toBeUndefined();
    await expect(dispatcher.resolve(alert())).resolves.toBeUndefined();
  });
});
