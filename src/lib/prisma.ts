import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import pg from "pg";
import dotenv from "dotenv";
import { publishDatabaseChange } from "../cache/CacheInvalidationManager";
import { logger } from "../config/logger";
import {
  dbSlowQueriesTotal,
  dbQueryDuration,
  dbQueriesTotal,
} from "../metrics/queryMetrics";

// Ensure environment variables are loaded
dotenv.config();

// Slow query threshold in milliseconds (configurable via environment variable)
const SLOW_QUERY_THRESHOLD_MS = Number(process.env.SLOW_QUERY_THRESHOLD_MS ?? 100);

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined;
};

/**
 * Prisma models whose writes can invalidate cached API responses (Issue #789).
 * Extend this list as new cached routes are added.
 */
const CACHE_RELEVANT_MODELS = new Set([
  "OnChainPrice",
  "PriceHistory",
  "MultiSigPrice",
  "MultiSigSignature",
  "ProviderReputation",
  "Currency",
  "DerivedAsset",
  "GovernanceVote",
]);

// Lazy initialization using a Proxy to prevent crashes during imports in test environments
export const prisma = new Proxy({} as PrismaClient, {
  get(target, prop, receiver) {
    if (!globalForPrisma.prisma) {
      // Ensure environment variables are loaded before initialization
      dotenv.config();

      const connectionString = process.env.DATABASE_URL;
      if (!connectionString) {
        throw new Error("DATABASE_URL must be defined");
      }
      const pool = new pg.Pool({
        connectionString,
        max: Number(process.env.PG_POOL_MAX ?? 20),
        min: Number(process.env.PG_POOL_MIN ?? 0),
        idleTimeoutMillis: Number(process.env.PG_POOL_IDLE_TIMEOUT_MS ?? 10000),
        connectionTimeoutMillis: Number(process.env.PG_POOL_CONNECTION_TIMEOUT_MS ?? 5000),
      });
      const adapter = new PrismaPg(pool);
      const baseClient = new PrismaClient({ adapter });

      // Issue #789 – Off-Chain Cache Invalidation Manager: report cache-relevant
      // database modifications so stale Redis response caches are purged as soon
      // as the underlying data changes. The extension is non-blocking and never
      // throws into the caller: any notification failure is swallowed and logged.
      // Issue #1014 – PostgreSQL Query Execution Time Tracker and Slow Query Logger
      globalForPrisma.prisma = baseClient.$extends({
        query: {
          $allModels: {
            async $allOperations({ model, operation, args, query }) {
              const startTime = Date.now();
              const result = await query(args);
              const durationMs = Date.now() - startTime;

              // Track query duration in Prometheus histogram
              dbQueryDuration.observe(
                {
                  model: String(model),
                  operation: operation as string,
                },
                durationMs,
              );

              // Increment total query counter
              dbQueriesTotal.inc({
                model: String(model),
                operation: operation as string,
              });

              // Log slow queries that exceed the threshold
              if (durationMs > SLOW_QUERY_THRESHOLD_MS) {
                logger.warn(
                  `[Slow Query] Model: ${String(model)}, Operation: ${operation}, Duration: ${durationMs}ms, Args: ${JSON.stringify(args)}`,
                );
                // Increment Prometheus counter for slow queries
                dbSlowQueriesTotal.inc({
                  model: String(model),
                  operation: operation as string,
                });
              }

              if (CACHE_RELEVANT_MODELS.has(String(model))) {
                try {
                  void publishDatabaseChange({
                    model: String(model),
                    operation: operation as any,
                  });
                } catch (error) {
                  console.error(
                    "[Prisma] Cache invalidation hook failed:",
                    error,
                  );
                }
              }
              return result;
            },
          },
        },
      }) as unknown as PrismaClient;
    }
    const value = (globalForPrisma.prisma as any)[prop];
    if (typeof value === "function") {
      return value.bind(globalForPrisma.prisma);
    }
    return value;
  },
});

export default prisma;
