/**
 * src/services/eventBus/queueDepthCollector.ts
 *
 * Reads the live backlog of every watched queue (Issue #1055).
 *
 * Two transports are supported:
 *
 *   Redis  — list / stream / set lengths plus `PUBSUB NUMSUB` subscriber counts
 *   AMQP   — passive `queue.declare` against the Celery broker, optionally
 *            enriched with the RabbitMQ management API for unacked counts
 *
 * Every probe is wrapped in a timeout and never throws: a queue that cannot be
 * reached is reported with `pending = -1` and an `error` string so a broker
 * outage degrades the dashboard instead of killing the collection loop.
 */

import { logger } from "../../utils/logger";
import type {
  AmqpDepthReader,
  QueueDepthReading,
  QueueDepthSample,
  QueueDescriptor,
  RedisDepthReader,
} from "./types";

/** Sentinel `pending` value used when a probe failed. */
export const UNKNOWN_DEPTH = -1;

export interface QueueDepthCollectorOptions {
  queues: QueueDescriptor[];
  redis?: RedisDepthReader | null;
  amqp?: AmqpDepthReader | null;
  probeTimeoutMs?: number;
  now?: () => number;
}

export interface QueueDepthReport {
  samples: QueueDepthSample[];
  totalPending: number;
  /** Queues whose probe failed this cycle. */
  probeErrors: string[];
  observedAt: string;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Polls a fixed catalogue of queues and returns one sample per queue.
 */
export class QueueDepthCollector {
  private readonly queues: QueueDescriptor[];
  private readonly redis: RedisDepthReader | null;
  private readonly amqp: AmqpDepthReader | null;
  private readonly probeTimeoutMs: number;
  private readonly now: () => number;

  constructor(options: QueueDepthCollectorOptions) {
    this.queues = [...options.queues];
    this.redis = options.redis ?? null;
    this.amqp = options.amqp ?? null;
    this.probeTimeoutMs = options.probeTimeoutMs ?? 5_000;
    this.now = options.now ?? Date.now;
  }

  /** The queue catalogue currently being watched. */
  getQueues(): QueueDescriptor[] {
    return this.queues.map((queue) => ({ ...queue }));
  }

  /** Add a queue at runtime. Re-adding a name replaces the previous entry. */
  registerQueue(descriptor: QueueDescriptor): () => void {
    this.queues.push(descriptor);
    return () => {
      const index = this.queues.findIndex((q) => q.name === descriptor.name);
      if (index >= 0) this.queues.splice(index, 1);
    };
  }

  /** Probe every queue in parallel. */
  async collect(): Promise<QueueDepthReport> {
    const samples = await Promise.all(
      this.queues.map((queue) => this.inspect(queue)),
    );
    const probeErrors = samples
      .map((sample) => sample.error)
      .filter((error): error is string => typeof error === "string");

    const totalPending = samples.reduce(
      (total, sample) => (sample.pending > 0 ? total + sample.pending : total),
      0,
    );

    return {
      samples,
      totalPending,
      probeErrors,
      observedAt: new Date(this.now()).toISOString(),
    };
  }

  /** Probe a single queue. */
  async inspect(queue: QueueDescriptor): Promise<QueueDepthSample> {
    const observedAt = new Date(this.now()).toISOString();
    try {
      const reading = await this.withTimeout(this.readQueue(queue));
      return {
        name: queue.name,
        pool: queue.pool,
        transport: queue.transport,
        pending: Math.max(0, reading.pending),
        unacked: reading.unacked,
        consumers: reading.consumers,
        oldestPendingAgeSeconds: reading.oldestPendingAgeSeconds ?? null,
        // A queue nobody is consuming is not draining, even if it is short.
        acceptingMessages: reading.consumers === null || reading.consumers > 0,
        observedAt,
      };
    } catch (error) {
      logger.warn(
        `[EventBus] Queue probe failed for ${queue.name}: ${errorMessage(error)}`,
      );
      return {
        name: queue.name,
        pool: queue.pool,
        transport: queue.transport,
        pending: UNKNOWN_DEPTH,
        unacked: null,
        consumers: null,
        oldestPendingAgeSeconds: null,
        acceptingMessages: true,
        observedAt,
        error: errorMessage(error),
      };
    }
  }

  private async readQueue(queue: QueueDescriptor): Promise<QueueDepthReading> {
    if (queue.transport === "amqp") {
      return this.readAmqpQueue(queue);
    }
    return this.readRedisQueue(queue);
  }

  private async readRedisQueue(
    queue: QueueDescriptor,
  ): Promise<QueueDepthReading> {
    const redis = this.redis;
    if (!redis) {
      throw new Error("No Redis reader configured for this collector");
    }

    // The local ingestion buffer is the only meaningful backlog for a pub/sub
    // channel, because Redis pub/sub drops messages when nobody is subscribed.
    const localDepth = queue.getLocalDepth ? queue.getLocalDepth() : 0;

    switch (queue.transport) {
      case "redis-list":
        return {
          pending:
            (await redis.listLength(this.requireKey(queue))) + localDepth,
          unacked: null,
          consumers: null,
          oldestPendingAgeSeconds: await this.oldestAge(redis, queue),
        };
      case "redis-set":
        return {
          pending: (await redis.setLength(this.requireKey(queue))) + localDepth,
          unacked: null,
          consumers: null,
          oldestPendingAgeSeconds: null,
        };
      case "redis-stream":
        return {
          pending:
            (await redis.streamLength(this.requireKey(queue))) + localDepth,
          unacked: null,
          consumers: null,
          oldestPendingAgeSeconds: await this.oldestAge(redis, queue),
        };
      case "redis-pubsub": {
        const subscribers = await redis.channelSubscribers(
          this.requireChannel(queue),
        );
        return {
          pending: localDepth,
          unacked: null,
          consumers: subscribers,
          oldestPendingAgeSeconds: null,
        };
      }
      default:
        throw new Error(`Unsupported Redis transport: ${queue.transport}`);
    }
  }

  private async oldestAge(
    redis: RedisDepthReader,
    queue: QueueDescriptor,
  ): Promise<number | null> {
    if (!redis.oldestEntryAgeSeconds) return null;
    try {
      const age = await redis.oldestEntryAgeSeconds(this.requireKey(queue));
      return age === null ? null : Math.max(0, age);
    } catch {
      // Age is best-effort telemetry — never fail a probe over it.
      return null;
    }
  }

  private async readAmqpQueue(
    queue: QueueDescriptor,
  ): Promise<QueueDepthReading> {
    const amqp = this.amqp;
    if (!amqp) {
      throw new Error("No AMQP reader configured for this collector");
    }
    const queueName = this.requireKey(queue);
    const declared = await amqp.checkQueue(queueName);

    let unacked: number | null = null;
    if (amqp.managementQueueStats) {
      try {
        const stats = await amqp.managementQueueStats(queueName);
        unacked = stats ? stats.messagesUnacknowledged : null;
      } catch {
        unacked = null;
      }
    }

    return {
      pending: declared.messageCount,
      unacked,
      consumers: declared.consumerCount,
      oldestPendingAgeSeconds: null,
    };
  }

  private requireKey(queue: QueueDescriptor): string {
    if (!queue.key) {
      throw new Error(`Queue ${queue.name} is missing its Redis/AMQP key`);
    }
    return queue.key;
  }

  private requireChannel(queue: QueueDescriptor): string {
    if (!queue.channel) {
      throw new Error(`Queue ${queue.name} is missing its pub/sub channel`);
    }
    return queue.channel;
  }

  private async withTimeout<T>(promise: Promise<T>): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        promise,
        new Promise<T>((_resolve, reject) => {
          timer = setTimeout(
            () =>
              reject(
                new Error(
                  `Queue probe timed out after ${this.probeTimeoutMs}ms`,
                ),
              ),
            this.probeTimeoutMs,
          );
          timer.unref?.();
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}
