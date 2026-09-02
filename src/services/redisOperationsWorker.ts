import { getRedisClient } from "../lib/redis";
import {
  AlertSeverity,
  AlertType,
  NotificationService,
} from "./notificationService";

const DEFAULT_STREAM_MAX_LENGTH = 100_000;

function compareStreamIds(left: string, right: string): number {
  const [leftMs, leftSeq = "0"] = left.split("-");
  const [rightMs, rightSeq = "0"] = right.split("-");
  const msDifference = BigInt(leftMs ?? "0") - BigInt(rightMs ?? "0");
  if (msDifference !== 0n) return msDifference < 0n ? -1 : 1;
  const seqDifference = BigInt(leftSeq) - BigInt(rightSeq);
  return seqDifference === 0n ? 0 : seqDifference < 0n ? -1 : 1;
}

/** Maintains Redis event streams and raises capacity alerts without deleting pending work. */
export class RedisOperationsWorker {
  private timer: ReturnType<typeof setInterval> | undefined;
  private alertActive = false;
  private lastHeartbeatAt: number | null = null;

  constructor(
    private readonly notifications = new NotificationService(),
    private readonly streamMaxLength = Number(
      process.env.REDIS_STREAM_MAX_LENGTH ?? DEFAULT_STREAM_MAX_LENGTH,
    ),
    private readonly memoryThresholdPercent = Number(
      process.env.REDIS_MEMORY_THRESHOLD_PERCENT ?? "85",
    ),
    private readonly intervalMs = Number(
      process.env.REDIS_OPERATIONS_INTERVAL_MS ?? "60000",
    ),
  ) {}

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.runOnce(), this.intervalMs);
    void this.runOnce();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  async runOnce(): Promise<void> {
    this.lastHeartbeatAt = Date.now();
    const redis = getRedisClient();
    if (!redis?.isOpen) return;
    await redis.sendCommand([
      "CONFIG",
      "SET",
      "maxmemory-policy",
      "volatile-lru",
    ]);
    await this.monitorMemory();
    for await (const stream of this.eventStreams())
      await this.trimStream(stream);
  }

  getLastHeartbeatAt(): number | null {
    return this.lastHeartbeatAt;
  }

  getHeartbeatTimeoutMs(): number {
    return Math.max(this.intervalMs * 2, 15_000);
  }

  private async *eventStreams(): AsyncGenerator<string> {
    const redis = getRedisClient();
    if (!redis?.isOpen) return;
    for await (const keys of redis.scanIterator({
      MATCH: "events:*",
      TYPE: "stream",
    })) {
      for (const key of keys) yield key;
    }
  }

  async trimStream(stream: string): Promise<void> {
    const redis = getRedisClient();
    if (!redis?.isOpen) return;
    const groups = (await redis.sendCommand([
      "XINFO",
      "GROUPS",
      stream,
    ])) as unknown[][];
    let earliestPending: string | undefined;
    for (const group of groups) {
      const groupName = String(
        group[group.findIndex((value) => value === "name") + 1] ?? "",
      );
      if (!groupName) continue;
      const pending = (await redis.sendCommand([
        "XPENDING",
        stream,
        groupName,
        "-",
        "+",
        "1",
      ])) as unknown[][];
      const id = pending[0]?.[0];
      if (
        typeof id === "string" &&
        (!earliestPending || compareStreamIds(id, earliestPending) < 0)
      )
        earliestPending = id;
    }
    if (earliestPending) {
      // MINID keeps the oldest pending message and everything after it intact.
      await redis.sendCommand(["XTRIM", stream, "MINID", "~", earliestPending]);
      return;
    }
    await redis.sendCommand([
      "XTRIM",
      stream,
      "MAXLEN",
      "~",
      String(this.streamMaxLength),
    ]);
  }

  private async monitorMemory(): Promise<void> {
    const redis = getRedisClient();
    if (!redis?.isOpen) return;
    const info = await redis.sendCommand(["INFO", "memory"]);
    const metrics = Object.fromEntries(
      String(info)
        .split("\r\n")
        .flatMap((line) => {
          const index = line.indexOf(":");
          return index < 0
            ? []
            : [[line.slice(0, index), line.slice(index + 1)]];
        }),
    );
    const used = Number(metrics.used_memory ?? 0);
    const capacity =
      Number(metrics.maxmemory ?? 0) ||
      Number(process.env.REDIS_MEMORY_CAPACITY_BYTES ?? 0);
    if (!capacity) return;
    const usagePercent = (used / capacity) * 100;
    if (usagePercent >= this.memoryThresholdPercent && !this.alertActive) {
      this.alertActive = true;
      await this.notifications.sendAlert({
        type: AlertType.REDIS_MEMORY_THRESHOLD,
        severity: AlertSeverity.CRITICAL,
        title: "Redis memory threshold exceeded",
        message: `Redis is using ${usagePercent.toFixed(1)}% of its configured capacity.`,
        details: {
          usedMemoryBytes: used,
          capacityBytes: capacity,
          usagePercent,
        },
        timestamp: new Date(),
        service: "redis-operations-worker",
      });
    } else if (usagePercent < this.memoryThresholdPercent)
      this.alertActive = false;
  }
}

export const redisOperationsWorker = new RedisOperationsWorker();
