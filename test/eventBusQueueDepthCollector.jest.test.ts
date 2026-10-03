import { jest } from "@jest/globals";
import {
  QueueDepthCollector,
  UNKNOWN_DEPTH,
} from "../src/services/eventBus/queueDepthCollector";
import { ageFromJsonPayload } from "../src/services/eventBus/readers";
import type {
  AmqpDepthReader,
  QueueDescriptor,
  QueueDepthSample,
  RedisDepthReader,
} from "../src/services/eventBus/types";

function fakeRedis(
  overrides: Partial<RedisDepthReader> = {},
): RedisDepthReader {
  return {
    listLength: jest.fn(async () => 5),
    setLength: jest.fn(async () => 0),
    streamLength: jest.fn(async () => 0),
    channelSubscribers: jest.fn(async () => 0),
    oldestEntryAgeSeconds: jest.fn(async () => null),
    ...overrides,
  };
}

function fakeAmqp(overrides: Partial<AmqpDepthReader> = {}): AmqpDepthReader {
  return {
    checkQueue: jest.fn(async () => ({ messageCount: 0, consumerCount: 0 })),
    ...overrides,
  };
}

const CELERY_QUEUES: QueueDescriptor[] = [
  {
    name: "celery:webhook.retry",
    pool: "celery-webhook",
    transport: "amqp",
    key: "webhook.retry",
  },
  {
    name: "redis:dlq",
    pool: "ingestion-dlq",
    transport: "redis-list",
    key: "stellarflow:dlq",
  },
];

describe("QueueDepthCollector", () => {
  it("reports pending depth, unacked count and consumers per queue", async () => {
    const amqp = fakeAmqp({
      checkQueue: jest.fn(async () => ({
        messageCount: 1200,
        consumerCount: 2,
      })),
      managementQueueStats: jest.fn(async () => ({
        messagesReady: 1200,
        messagesUnacknowledged: 17,
      })),
    });
    const redis = fakeRedis({
      listLength: jest.fn(async () => 42),
      oldestEntryAgeSeconds: jest.fn(async () => 90),
    });
    const collector = new QueueDepthCollector({
      queues: CELERY_QUEUES,
      amqp,
      redis,
      now: () => 1_700_000_000_000,
    });

    const report = await collector.collect();

    expect(report.observedAt).toBe(new Date(1_700_000_000_000).toISOString());
    expect(report.totalPending).toBe(1242);
    expect(report.probeErrors).toEqual([]);

    const [celery, dlq] = report.samples as [
      QueueDepthSample,
      QueueDepthSample,
    ];
    expect(celery).toMatchObject({
      name: "celery:webhook.retry",
      pool: "celery-webhook",
      transport: "amqp",
      pending: 1200,
      unacked: 17,
      consumers: 2,
      acceptingMessages: true,
    });
    expect(dlq).toMatchObject({
      name: "redis:dlq",
      transport: "redis-list",
      pending: 42,
      unacked: null,
      consumers: null,
      oldestPendingAgeSeconds: 90,
    });
    expect(amqp.checkQueue).toHaveBeenCalledWith("webhook.retry");
    expect(redis.listLength).toHaveBeenCalledWith("stellarflow:dlq");
  });

  it("counts pub/sub channel subscribers and the local ingestion buffer", async () => {
    const redis = fakeRedis({
      channelSubscribers: jest.fn(async () => 3),
    });
    const collector = new QueueDepthCollector({
      queues: [
        {
          name: "redis:pubsub:ledger",
          pool: "redis-pubsub",
          transport: "redis-pubsub",
          channel: "ledger",
          getLocalDepth: () => 250,
        },
      ],
      redis,
    });

    const [sample] = (await collector.collect()).samples;

    expect(sample).toMatchObject({
      pending: 250,
      consumers: 3,
      acceptingMessages: true,
    });
    expect(redis.channelSubscribers).toHaveBeenCalledWith("ledger");
  });

  it("marks a pub/sub channel with no subscribers as not accepting messages", async () => {
    const collector = new QueueDepthCollector({
      queues: [
        {
          name: "redis:pubsub:ledger",
          pool: "redis-pubsub",
          transport: "redis-pubsub",
          channel: "ledger",
        },
      ],
      redis: fakeRedis({ channelSubscribers: jest.fn(async () => 0) }),
    });

    const [sample] = (await collector.collect()).samples;

    expect(sample?.consumers).toBe(0);
    expect(sample?.acceptingMessages).toBe(false);
  });

  it("isolates a failing probe without failing the whole cycle", async () => {
    const collector = new QueueDepthCollector({
      queues: CELERY_QUEUES,
      amqp: fakeAmqp({
        checkQueue: jest.fn(async () => {
          throw new Error("ECONNREFUSED 127.0.0.1:5672");
        }),
      }),
      redis: fakeRedis({ listLength: jest.fn(async () => 7) }),
    });

    const report = await collector.collect();

    expect(report.samples[0]?.pending).toBe(UNKNOWN_DEPTH);
    expect(report.samples[0]?.error).toContain("ECONNREFUSED");
    expect(report.samples[1]?.pending).toBe(7);
    expect(report.totalPending).toBe(7);
    expect(report.probeErrors).toHaveLength(1);
  });

  it("times out a probe that never settles", async () => {
    const collector = new QueueDepthCollector({
      queues: CELERY_QUEUES,
      amqp: fakeAmqp({
        checkQueue: jest.fn(() => new Promise<never>(() => undefined)),
      }),
      redis: fakeRedis(),
      probeTimeoutMs: 10,
    });

    const report = await collector.collect();

    expect(report.samples[0]?.error).toContain("timed out");
    expect(report.samples[0]?.pending).toBe(UNKNOWN_DEPTH);
  });

  it("sums set cardinality and stream length backlogs", async () => {
    const redis = fakeRedis({
      setLength: jest.fn(async () => 11),
      streamLength: jest.fn(async () => 29),
    });
    const collector = new QueueDepthCollector({
      queues: [
        { name: "s", pool: "p", transport: "redis-set", key: "retry:set" },
        { name: "t", pool: "p", transport: "redis-stream", key: "events" },
      ],
      redis,
    });

    const report = await collector.collect();

    expect(report.samples.map((sample) => sample.pending)).toEqual([11, 29]);
    expect(report.totalPending).toBe(40);
  });

  it("fails fast when the transport has no reader configured", async () => {
    const collector = new QueueDepthCollector({
      queues: [{ name: "q", pool: "p", transport: "amqp", key: "celery" }],
    });

    const report = await collector.collect();

    expect(report.samples[0]?.error).toContain("No AMQP reader");
  });

  it("registers and unregisters a queue at runtime", async () => {
    const redis = fakeRedis({ listLength: jest.fn(async () => 3) });
    const collector = new QueueDepthCollector({ queues: [], redis });

    const unregister = collector.registerQueue({
      name: "redis:extra",
      pool: "p",
      transport: "redis-list",
      key: "extra",
    });
    expect((await collector.collect()).samples).toHaveLength(1);

    unregister();
    expect((await collector.collect()).samples).toHaveLength(0);
  });
});

describe("ageFromJsonPayload", () => {
  const now = Date.parse("2026-01-01T00:00:00.000Z");

  it("reads an ISO enqueue timestamp", () => {
    const payload = JSON.stringify({ enqueued_at: "2026-01-01T00:00:00.000Z" });
    expect(ageFromJsonPayload(payload, now)).toBe(0);
  });

  it("converts a unix timestamp in seconds and milliseconds", () => {
    expect(
      ageFromJsonPayload(JSON.stringify({ createdAt: now / 1000 - 30 }), now),
    ).toBe(30);
    expect(
      ageFromJsonPayload(JSON.stringify({ timestamp: now - 45_000 }), now),
    ).toBe(45);
  });

  it("returns null for unparsable or timestamp-free payloads", () => {
    expect(ageFromJsonPayload("not json", now)).toBeNull();
    expect(ageFromJsonPayload(JSON.stringify({ foo: "bar" }), now)).toBeNull();
  });
});
