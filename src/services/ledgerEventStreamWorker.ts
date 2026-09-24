import { type RedisClientType } from "redis";
import { getRedisClient } from "../lib/redis";
import { logger } from "../utils/logger";

export const LEDGER_EVENTS_STREAM = "stream:ledger-events";
export const LEDGER_EVENTS_DLQ_STREAM = "stream:ledger-events:dlq";
export const LEDGER_EVENTS_GROUP =
  process.env.LEDGER_EVENTS_CONSUMER_GROUP ?? "stellarflow-backend";

const DEFAULT_BATCH_SIZE = 10;
const DEFAULT_BLOCK_MS = 2_000;
const DEFAULT_CLAIM_IDLE_MS = 60_000;
const DEFAULT_MAX_DELIVERIES = 3;

export interface LedgerEvent {
  type: string;
  payload: Record<string, unknown>;
  sequenceNumber?: string;
  occurredAt?: string;
}

export type LedgerEventHandler = (
  event: LedgerEvent,
  streamId: string,
) => Promise<void>;

interface StreamMessage {
  id: string;
  fields: Record<string, string>;
}

function asStreamMessages(value: unknown): StreamMessage[] {
  if (!Array.isArray(value)) return [];

  return value.flatMap((entry) => {
    if (!Array.isArray(entry) || typeof entry[0] !== "string") return [];
    const fields = entry[1];
    if (!Array.isArray(fields)) return [];

    const parsed: Record<string, string> = {};
    for (let index = 0; index < fields.length; index += 2) {
      const key = fields[index];
      const fieldValue = fields[index + 1];
      if (typeof key === "string" && typeof fieldValue === "string") {
        parsed[key] = fieldValue;
      }
    }
    return [{ id: entry[0], fields: parsed }];
  });
}

function parseReadResponse(value: unknown): StreamMessage[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((stream) => {
    if (!Array.isArray(stream)) return [];
    return asStreamMessages(stream[1]);
  });
}

function parseEvent(message: StreamMessage): LedgerEvent {
  const parsed = JSON.parse(message.fields.payload ?? "{}");
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    typeof parsed.type !== "string" ||
    typeof parsed.payload !== "object" ||
    parsed.payload === null
  ) {
    throw new Error("Ledger event must contain a type and payload");
  }
  return parsed as LedgerEvent;
}

export async function publishLedgerEvent(event: LedgerEvent): Promise<string> {
  const redis = getRedisClient();
  if (!redis?.isOpen) throw new Error("Redis is not available");

  return redis.xAdd(LEDGER_EVENTS_STREAM, "*", {
    payload: JSON.stringify(event),
  });
}

export class LedgerEventStreamWorker {
  private readonly consumerName: string;
  private readonly batchSize: number;
  private readonly blockMs: number;
  private readonly claimIdleMs: number;
  private readonly maxDeliveries: number;
  private readonly handler: LedgerEventHandler;
  private blockingClient: RedisClientType | null = null;
  private running = false;
  private loopPromise: Promise<void> | null = null;
  private lastPendingCount = 0;

  constructor(
    handler: LedgerEventHandler = async (event, streamId) => {
      logger.info(
        `[LedgerEventStreamWorker] No handler registered for ${event.type} (${streamId})`,
      );
    },
    options: {
      consumerName?: string;
      batchSize?: number;
      blockMs?: number;
      claimIdleMs?: number;
      maxDeliveries?: number;
    } = {},
  ) {
    this.handler = handler;
    this.consumerName =
      options.consumerName ??
      `${process.env.HOSTNAME ?? "backend"}-${process.pid}`;
    this.batchSize = options.batchSize ?? DEFAULT_BATCH_SIZE;
    this.blockMs = options.blockMs ?? DEFAULT_BLOCK_MS;
    this.claimIdleMs = options.claimIdleMs ?? DEFAULT_CLAIM_IDLE_MS;
    this.maxDeliveries = options.maxDeliveries ?? DEFAULT_MAX_DELIVERIES;
  }

  async start(): Promise<void> {
    if (this.running) return;
    const redis = getRedisClient();
    if (!redis?.isOpen) {
      logger.warn("[LedgerEventStreamWorker] Redis is unavailable");
      return;
    }

    await this.ensureConsumerGroup(redis);
    this.blockingClient = redis.duplicate();
    this.blockingClient.on("error", (error) => {
      logger.error("[LedgerEventStreamWorker] Blocking Redis client error", error);
    });
    await this.blockingClient.connect();
    this.running = true;
    this.loopPromise = this.consumeLoop();
    logger.info(
      `[LedgerEventStreamWorker] Consuming ${LEDGER_EVENTS_STREAM} as ${this.consumerName}`,
    );
  }

  async stop(): Promise<void> {
    this.running = false;
    if (this.loopPromise) await this.loopPromise;
    this.loopPromise = null;
    if (this.blockingClient?.isOpen) await this.blockingClient.quit();
    this.blockingClient = null;
  }

  getUnacknowledgedCount(): number {
    return this.lastPendingCount;
  }

  async refreshUnacknowledgedCount(): Promise<number> {
    const redis = getRedisClient();
    if (!redis?.isOpen) return this.lastPendingCount;
    const response = (await redis.sendCommand([
      "XPENDING",
      LEDGER_EVENTS_STREAM,
      LEDGER_EVENTS_GROUP,
    ])) as unknown[];
    this.lastPendingCount = Number(response[0] ?? 0);
    return this.lastPendingCount;
  }

  private async ensureConsumerGroup(redis: RedisClientType): Promise<void> {
    try {
      await redis.sendCommand([
        "XGROUP",
        "CREATE",
        LEDGER_EVENTS_STREAM,
        LEDGER_EVENTS_GROUP,
        "0",
        "MKSTREAM",
      ]);
    } catch (error) {
      if (!String(error).includes("BUSYGROUP")) throw error;
    }
  }

  private async consumeLoop(): Promise<void> {
    while (this.running) {
      try {
        await this.claimPendingMessages();
        const messages = await this.readNewMessages();
        for (const message of messages) await this.processMessage(message);
        await this.refreshUnacknowledgedCount();
      } catch (error) {
        logger.error("[LedgerEventStreamWorker] Consumer loop failed", error);
        await new Promise((resolve) => setTimeout(resolve, 2_000));
      }
    }
  }

  private async readNewMessages(): Promise<StreamMessage[]> {
    if (!this.blockingClient?.isOpen) return [];
    const response = await this.blockingClient.sendCommand([
      "XREADGROUP",
      "GROUP",
      LEDGER_EVENTS_GROUP,
      this.consumerName,
      "COUNT",
      String(this.batchSize),
      "BLOCK",
      String(this.blockMs),
      "STREAMS",
      LEDGER_EVENTS_STREAM,
      ">",
    ]);
    return parseReadResponse(response);
  }

  private async claimPendingMessages(): Promise<void> {
    const redis = getRedisClient();
    if (!redis?.isOpen) return;
    const response = (await redis.sendCommand([
      "XAUTOCLAIM",
      LEDGER_EVENTS_STREAM,
      LEDGER_EVENTS_GROUP,
      this.consumerName,
      String(this.claimIdleMs),
      "0-0",
      "COUNT",
      String(this.batchSize),
    ])) as unknown[];
    for (const message of asStreamMessages(response[1])) {
      await this.processMessage(message);
    }
  }

  private async processMessage(message: StreamMessage): Promise<void> {
    const redis = getRedisClient();
    if (!redis?.isOpen) return;

    try {
      const event = parseEvent(message);
      await this.handler(event, message.id);
      await redis.xAck(LEDGER_EVENTS_STREAM, LEDGER_EVENTS_GROUP, message.id);
    } catch (error) {
      const deliveries = await this.getDeliveryCount(message.id);
      if (deliveries >= this.maxDeliveries) {
        await this.moveToDeadLetterQueue(message, error);
        await redis.xAck(LEDGER_EVENTS_STREAM, LEDGER_EVENTS_GROUP, message.id);
        return;
      }
      logger.error(
        `[LedgerEventStreamWorker] Failed ${message.id}; delivery ${deliveries}/${this.maxDeliveries}`,
        error,
      );
    }
  }

  private async getDeliveryCount(messageId: string): Promise<number> {
    const redis = getRedisClient();
    if (!redis?.isOpen) return 1;
    const response = (await redis.sendCommand([
      "XPENDING",
      LEDGER_EVENTS_STREAM,
      LEDGER_EVENTS_GROUP,
      messageId,
      messageId,
      "1",
    ])) as unknown[][];
    return Number(response[0]?.[3] ?? 1);
  }

  private async moveToDeadLetterQueue(
    message: StreamMessage,
    error: unknown,
  ): Promise<void> {
    const redis = getRedisClient();
    if (!redis?.isOpen) return;
    await redis.xAdd(LEDGER_EVENTS_DLQ_STREAM, "*", {
      originalStream: LEDGER_EVENTS_STREAM,
      originalId: message.id,
      payload: message.fields.payload ?? "{}",
      error: error instanceof Error ? error.message : String(error),
      failedAt: new Date().toISOString(),
    });
    logger.warn(
      `[LedgerEventStreamWorker] Moved ${message.id} to ${LEDGER_EVENTS_DLQ_STREAM}`,
    );
  }
}

export const ledgerEventStreamWorker = new LedgerEventStreamWorker();