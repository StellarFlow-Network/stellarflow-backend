import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import pg from "pg";
import dotenv from "dotenv";
import { publishDatabaseChange } from "../cache/CacheInvalidationManager";
// Ensure environment variables are loaded
dotenv.config();
const globalForPrisma = globalThis;
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
export const prisma = new Proxy({}, {
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
            globalForPrisma.prisma = baseClient.$extends({
                query: {
                    $allModels: {
                        async $allOperations({ model, operation, args, query }) {
                            const result = await query(args);
                            if (CACHE_RELEVANT_MODELS.has(String(model))) {
                                try {
                                    void publishDatabaseChange({
                                        model: String(model),
                                        operation: operation,
                                    });
                                }
                                catch (error) {
                                    console.error("[Prisma] Cache invalidation hook failed:", error);
                                }
                            }
                            return result;
                        },
                    },
                },
            });
        }
        const value = globalForPrisma.prisma[prop];
        if (typeof value === "function") {
            return value.bind(globalForPrisma.prisma);
        }
        return value;
    },
});
export default prisma;
//# sourceMappingURL=prisma.js.map