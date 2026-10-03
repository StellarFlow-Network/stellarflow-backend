import promClient from "prom-client";

/** Current Redis memory usage in bytes, updated by the operations worker. */
export const redisMemoryUsedBytes = new promClient.Gauge({
  name: "redis_memory_used_bytes",
  help: "Current Redis memory usage in bytes, as reported by INFO memory",
});

/** Parse Redis INFO memory output and expose the absolute used-memory value. */
export function parseRedisUsedMemory(info: string): number | null {
  const value = info
    .split(/\r?\n/)
    .find((line) => line.startsWith("used_memory:"))
    ?.slice("used_memory:".length);
  if (value === undefined) return null;
  const bytes = Number(value);
  return Number.isSafeInteger(bytes) && bytes >= 0 ? bytes : null;
}
