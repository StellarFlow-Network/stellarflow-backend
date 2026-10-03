/**
 * src/services/eventBus/readers.ts
 *
 * Production `RedisDepthReader` / `AmqpDepthReader` implementations.
 *
 * Both readers are created lazily and memoised: importing this module must not
 * open sockets, because the metric definitions in `eventBusMetrics.ts` are
 * imported by unit tests and by the Prometheus registry during test runs.
 */

import amqp, { type Channel, type ChannelModel } from "amqplib";
import { logger } from "../../utils/logger";
import { createTimeoutSignal } from "../../utils/httpTimeout";
import type { AmqpDepthReader, RedisDepthReader } from "./types";

/** Structural subset of the `redis` v5 client used for depth reporting. */
export interface MinimalRedisClient {
  lLen(key: string): Promise<number>;
  sCard(key: string): Promise<number>;
  xLen(key: string): Promise<number>;
  lIndex(key: string, index: number): Promise<string | null>;
  sendCommand(args: string[]): Promise<unknown>;
}

/**
 * Reads queue depths out of the shared `redis` v5 client
 * (the same singleton used by `src/lib/redis.ts`).
 *
 * Only the handful of commands needed for depth reporting are used, so the
 * reader stays compatible with both a real client and the test doubles used by
 * the collector test-suite.
 */
export class NodeRedisDepthReader implements RedisDepthReader {
  private readonly client: MinimalRedisClient;

  constructor(client: MinimalRedisClient) {
    this.client = client;
  }

  listLength(key: string): Promise<number> {
    return this.client.lLen(key);
  }

  setLength(key: string): Promise<number> {
    return this.client.sCard(key);
  }

  streamLength(key: string): Promise<number> {
    return this.client.xLen(key);
  }

  async channelSubscribers(channel: string): Promise<number> {
    const reply = (await this.client.sendCommand([
      "PUBSUB",
      "NUMSUB",
      channel,
    ])) as Array<[string, number]>;
    // PUBSUB NUMSUB replies with one [channel, count] pair per channel.
    const first = reply[0];
    return Array.isArray(first) ? Number(first[1]) : 0;
  }

  /**
   * Age of the head entry of a list or stream, used to estimate how long a
   * message has been stuck. Returns `null` when the queue is empty or the
   * head carries no usable timestamp.
   */
  async oldestEntryAgeSeconds(key: string): Promise<number | null> {
    const head = await this.client.lIndex(key, 0).catch(() => null);
    if (!head) return null;
    return ageFromJsonPayload(head);
  }
}

/**
 * Pull an enqueue timestamp out of a serialised queue payload.
 *
 * Recognises the ISO-8601 keys used across the Python DLQ entries and the
 * TypeScript event payloads. Returns `null` when nothing matches so the caller
 * can omit the metric instead of exporting a bogus value.
 */
export function ageFromJsonPayload(
  raw: string,
  now: number = Date.now(),
): number | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;

  const record = parsed as Record<string, unknown>;
  for (const key of [
    "enqueued_at",
    "enqueuedAt",
    "published_at",
    "publishedAt",
    "created_at",
    "createdAt",
    "timestamp",
  ]) {
    const value = record[key];
    if (typeof value === "string") {
      const timestamp = Date.parse(value);
      if (!Number.isNaN(timestamp)) {
        return Math.max(0, (now - timestamp) / 1000);
      }
    }
    if (typeof value === "number" && Number.isFinite(value)) {
      // Milliseconds for 13-digit values, seconds otherwise.
      const millis = value > 1e11 ? value : value * 1000;
      return Math.max(0, (now - millis) / 1000);
    }
  }
  return null;
}

export interface AmqpReaderOptions {
  url: string;
  /** RabbitMQ management API base URL, e.g. http://rabbitmq:15672. */
  managementUrl?: string | null;
  vhost?: string;
  timeoutMs?: number;
}

/**
 * Passive-inspects Celery queues on the RabbitMQ broker.
 *
 * `checkQueue` is a passive declare, so it never mutates broker state and
 * never steals messages from a worker. Connections are memoised and reset on
 * close/error the same way `webhookRetryPublisher.ts` does.
 */
export class AmqpQueueDepthReader implements AmqpDepthReader {
  private readonly url: string;
  private readonly managementUrl: string | null;
  private readonly vhost: string;
  private readonly timeoutMs: number;
  private connection: ChannelModel | null = null;
  private connecting: Promise<ChannelModel> | null = null;
  private channelPromise: Promise<Channel> | null = null;

  constructor(options: AmqpReaderOptions) {
    this.url = options.url;
    this.managementUrl = options.managementUrl ?? null;
    this.vhost = options.vhost ?? "/";
    this.timeoutMs = options.timeoutMs ?? 5_000;
  }

  private reset(): void {
    this.connection = null;
    this.connecting = null;
    this.channelPromise = null;
  }

  private async getChannel(): Promise<Channel> {
    if (!this.channelPromise) {
      this.connecting ??= amqp.connect(this.url);
      this.channelPromise = this.connecting.then(async (connection) => {
        connection.on("close", () => this.reset());
        connection.on("error", () => this.reset());
        return connection.createChannel();
      });
    }
    return this.channelPromise;
  }

  async checkQueue(queue: string): Promise<{
    messageCount: number;
    consumerCount: number;
  }> {
    const channel = await this.getChannel();
    // checkQueue is a passive declare by definition: it never binds, never
    // creates and never consumes.
    const result = await channel.checkQueue(queue);
    return {
      messageCount: result.messageCount,
      consumerCount: result.consumerCount,
    };
  }

  /** Unacked counts are only exposed by the management plugin. */
  async managementQueueStats(
    queue: string,
  ): Promise<{ messagesReady: number; messagesUnacknowledged: number } | null> {
    if (!this.managementUrl) return null;
    const path = `/api/queues/${encodeURIComponent(this.vhost)}/${encodeURIComponent(queue)}`;
    const response = await fetch(`${this.managementUrl}${path}`, {
      headers: { accept: "application/json" },
      signal: createTimeoutSignal(this.timeoutMs),
    });
    if (!response.ok) {
      logger.debug(
        `[EventBus] RabbitMQ management API returned ${response.status} for ${queue}`,
      );
      return null;
    }
    const body = (await response.json()) as {
      messages_ready?: number;
      messages_unacknowledged?: number;
    };
    return {
      messagesReady: Number(body.messages_ready ?? 0),
      messagesUnacknowledged: Number(body.messages_unacknowledged ?? 0),
    };
  }

  async close(): Promise<void> {
    const channel = await this.channelPromise?.catch(() => null);
    await channel?.close().catch(() => undefined);
    const connection = await this.connecting?.catch(() => null);
    await connection?.close().catch(() => undefined);
    this.reset();
  }
}
