import { rateLimit, type Options } from "express-rate-limit";
import { RedisStore } from "rate-limit-redis";
import { Request, Response } from "express";
import { getRedisClient } from "../lib/redis";
import { appConfig } from "../config/configWatcher";
import prisma from "../lib/prisma";

/**
 * Resolves the real client IP, respecting X-Forwarded-For when the app is
 * behind a trusted reverse proxy (TRUST_PROXY=true).
 */
function resolveClientIp(req: Request): string {
  if (process.env.TRUST_PROXY === "true") {
    const forwarded = req.headers["x-forwarded-for"];
    if (forwarded) {
      const raw = Array.isArray(forwarded)
        ? forwarded[0]
        : forwarded.split(",")[0];
      const first = raw?.trim();
      if (first) return first;
    }
  }
  return req.ip ?? req.socket.remoteAddress ?? "unknown";
}

/**
 * Normalises an IP so that IPv4-mapped IPv6 addresses (::ffff:1.2.3.4)
 * compare equal to their plain IPv4 form.
 */
function normaliseIp(ip: string): string {
  return ip.startsWith("::ffff:") ? ip.slice(7) : ip;
}

/**
 * In-memory cache of whitelisted IPs loaded from the Relayer table.
 * Refreshed every WHITELIST_REFRESH_MS milliseconds so the middleware
 * never blocks on a DB query in the hot path.
 */
const WHITELIST_REFRESH_MS = 60_000; // 1 minute
let whitelistedIpCache: Set<string> = new Set();
let lastWhitelistRefresh = 0;

async function refreshWhitelistCache(): Promise<void> {
  try {
    const relayers = await prisma.relayer.findMany({
      where: { isActive: true },
      select: { whitelistedIps: true },
    });

    const ips = new Set<string>();

    // Always include ADMIN_IP from env
    const adminIp = process.env.ADMIN_IP;
    if (adminIp) {
      ips.add(normaliseIp(adminIp));
    }

    for (const relayer of relayers) {
      for (const ip of relayer.whitelistedIps) {
        ips.add(normaliseIp(ip));
      }
    }

    whitelistedIpCache = ips;
    lastWhitelistRefresh = Date.now();
  } catch (err) {
    console.error("[RateLimit] Failed to refresh IP whitelist cache:", err);
  }
}

// Kick off the first load immediately (non-blocking)
void refreshWhitelistCache();

/**
 * Returns true when the request IP is in the whitelist.
 * Triggers a background refresh if the cache is stale.
 */
function isWhitelisted(req: Request): boolean {
  const now = Date.now();
  if (now - lastWhitelistRefresh > WHITELIST_REFRESH_MS) {
    // Refresh in background — don't await so the hot path stays synchronous
    void refreshWhitelistCache();
  }

  const clientIp = normaliseIp(resolveClientIp(req));
  return whitelistedIpCache.has(clientIp);
}

/**
 * Builds the express-rate-limit options, wiring up the Redis store when a
 * Redis client is available and falling back to the default in-memory store
 * otherwise.
 */
function buildRateLimitOptions(): Partial<Options> {
  const redisClient = getRedisClient();

  const store = redisClient?.isOpen
    ? new RedisStore({
        // rate-limit-redis v4 uses sendCommand for redis v4+ clients
        sendCommand: async (...args: string[]) => {
          const result = await redisClient.sendCommand(args);
          // Cast through unknown to satisfy type checker
          return result as unknown as
            | boolean
            | number
            | string
            | (boolean | number | string)[];
        },
        prefix: "rl:",
      })
    : undefined; // falls back to express-rate-limit's built-in MemoryStore

  if (!store) {
    console.warn(
      "[RateLimit] Redis unavailable — using in-memory store. " +
        "Throttling will NOT be shared across multiple instances.",
    );
  }

  return {
    windowMs: appConfig.rateLimit.windowMs,
    max: appConfig.rateLimit.maxRequests,
    standardHeaders: true,
    legacyHeaders: false,
    ...(store ? { store } : {}),
    skip: (req: Request) => {
      // Bypass entirely when global throttling is disabled
      if (!appConfig.rateLimit.enabled) return true;
      // Bypass for whitelisted relayer / admin IPs
      return isWhitelisted(req);
    },
    keyGenerator: (req: Request) => normaliseIp(resolveClientIp(req)),
    handler: (_req: Request, res: Response) => {
      res.status(429).json({
        success: false,
        error: `Too many requests. Limit: ${appConfig.rateLimit.maxRequests} per ${Math.round(appConfig.rateLimit.windowMs / 60_000)} minutes.`,
        retryAfter: Math.ceil(appConfig.rateLimit.windowMs / 1000),
      });
    },
  };
}

/**
 * Dynamic rate-limit middleware.
 *
 * Configuration is read from `appConfig.rateLimit` on every request so that
 * changes made via the Admin Dashboard (or config.json hot-reload) take effect
 * without a server restart.
 *
 * The Redis store is initialised once at startup. If Redis is not available the
 * middleware degrades gracefully to an in-memory store.
 */
export const rateLimitMiddleware = rateLimit(buildRateLimitOptions());

/**
 * Expose the whitelist refresh function so admin routes can trigger an
 * immediate reload after updating relayer IPs.
 */
export { refreshWhitelistCache };
