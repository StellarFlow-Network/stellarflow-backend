import { Request, Response, NextFunction } from "express";
import { getRedisClient } from "../lib/redis";

export interface RateLimitOptions {
  windowMs?: number;
  maxPublicRequests?: number;
  maxAuthenticatedRequests?: number;
}

/**
 * Sliding window rate-limiting middleware using Redis.
 * Limits: 60 requests/minute for public routes, 300 requests/minute for authenticated clients.
 * Returns HTTP 429 (Too Many Requests) with Retry-After header.
 */
export function rateLimitMiddleware(options?: RateLimitOptions) {
  const windowMs = options?.windowMs ?? 60 * 1000;
  const maxPublic = options?.maxPublicRequests ?? 60;
  const maxAuth = options?.maxAuthenticatedRequests ?? 300;

  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const redis = getRedisClient();
    const now = Date.now();
    const windowKey = Math.floor(now / windowMs);
    
    // Determine client identifier and authentication status
    const isAuthenticated = Boolean(
      req.headers.authorization || (req as any).user || req.headers["x-api-key"]
    );
    const limit = isAuthenticated ? maxAuth : maxPublic;
    const identifier = (
      (req as any).user?.id ||
      req.headers["x-api-key"] ||
      req.ip ||
      req.socket.remoteAddress ||
       "anonymous"
    ).toString();

    const key = `ratelimit:${isAuthenticated ? "auth" : "public"}:${identifier}:${windowKey}`;

    if (!redis || !redis.isOpen) {
      // Fallback if Redis is unavailable
      return next();
    }

    try {
      const multi = redis.multi();
      multi.incr(key);
      multi.pExpire(key, windowMs);
      const results = await multi.exec();
      const currentCount = results && results[0] ? Number(results[0]) : 1;

      if (currentCount > limit) {
        const retryAfterSeconds = Math.ceil(windowMs / 1000);
        res.setHeader("Retry-After", String(retryAfterSeconds));
        res.status(429).json({
          error: "Too Many Requests",
          message: `Rate limit exceeded. Maximum allowed is ${limit} requests per ${windowMs / 1000} seconds.`,
          retryAfter: retryAfterSeconds,
        });
        return;
      }

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
    max: async (req: Request) => {
      if (req.apiKey && req.apiKey.tier) {
        const tier = req.apiKey.tier.toLowerCase();
        if (tier === 'institutional') return 10000;
        if (tier === 'developer') return 1000;
        return 100; // free tier
      }
      return appConfig.rateLimit.maxRequests;
    },
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
    handler: (req: Request, res: Response) => {
      let maxRequests = appConfig.rateLimit.maxRequests;
      if (req.apiKey && req.apiKey.tier) {
        const tier = req.apiKey.tier.toLowerCase();
        if (tier === 'institutional') maxRequests = 10000;
        else if (tier === 'developer') maxRequests = 1000;
        else maxRequests = 100;
      }
      res.status(429).json({
        ...apiErrorPayload(
          "RATE_LIMITED",
          `Too many requests. Limit: ${maxRequests} per ${Math.round(appConfig.rateLimit.windowMs / 60_000)} minutes.`,
        ),
        retryAfter: Math.ceil(appConfig.rateLimit.windowMs / 1000),
      });
    },
  };
}
