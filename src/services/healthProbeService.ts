import prisma from "../lib/prisma";
import { getRedisClient } from "../lib/redis";
import stellarProvider from "../lib/stellarProvider";

export const READINESS_UNAVAILABLE_STATUS = 530;

export type ProbeName = "database" | "redis" | "rpc";

export interface ProbeResult {
  name: ProbeName;
  healthy: boolean;
  error?: string;
}

export interface ReadinessReport {
  ready: boolean;
  timestamp: string;
  checks: Record<ProbeName, boolean>;
  errors: Partial<Record<ProbeName, string>>;
}

const DEFAULT_TIMEOUT_MS = 3_000;

function probeTimeoutMs(): number {
  const parsed = Number(process.env.HEALTH_PROBE_TIMEOUT_MS);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_TIMEOUT_MS;
}

async function withTimeout<T>(
  label: ProbeName,
  work: () => Promise<T>,
): Promise<T> {
  const timeoutMs = probeTimeoutMs();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work(),
      new Promise<T>((_, reject) => {
        timer = setTimeout(
          () =>
            reject(new Error(`${label} probe timed out after ${timeoutMs}ms`)),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export async function probeDatabase(): Promise<ProbeResult> {
  try {
    await withTimeout("database", () => prisma.$queryRaw`SELECT 1`);
    return { name: "database", healthy: true };
  } catch (error) {
    return {
      name: "database",
      healthy: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function probeRedis(): Promise<ProbeResult> {
  try {
    await withTimeout("redis", async () => {
      const redis = getRedisClient();
      if (!redis) {
        throw new Error("REDIS_URL is not configured");
      }
      if (!redis.isOpen) {
        throw new Error("Redis client is not connected");
      }
      const pong = await redis.ping();
      if (pong !== "PONG" && pong !== "pong") {
        throw new Error(`Unexpected Redis ping response: ${String(pong)}`);
      }
    });
    return { name: "redis", healthy: true };
  } catch (error) {
    return {
      name: "redis",
      healthy: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function probeRpc(): Promise<ProbeResult> {
  try {
    await withTimeout("rpc", async () => {
      const health = await stellarProvider.getRpcServer().getHealth();
      const status =
        health && typeof health === "object" && "status" in health
          ? String((health as { status: unknown }).status).toLowerCase()
          : "";
      if (status && status !== "healthy") {
        throw new Error(`RPC status is ${status}`);
      }
    });
    return { name: "rpc", healthy: true };
  } catch (error) {
    return {
      name: "rpc",
      healthy: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function getReadinessReport(): Promise<ReadinessReport> {
  const probes = await Promise.all([probeDatabase(), probeRedis(), probeRpc()]);

  const checks = {} as Record<ProbeName, boolean>;
  const errors: Partial<Record<ProbeName, string>> = {};

  for (const probe of probes) {
    checks[probe.name] = probe.healthy;
    if (!probe.healthy && probe.error) {
      errors[probe.name] = probe.error;
    }
  }

  return {
    ready: probes.every((probe) => probe.healthy),
    timestamp: new Date().toISOString(),
    checks,
    errors,
  };
}
