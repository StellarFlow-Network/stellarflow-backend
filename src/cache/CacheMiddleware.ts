import { Request, Response, NextFunction } from "express";
import { cacheService } from "./CacheService";

interface CacheOptions {
  ttl: number;
  keyGenerator?: (req: Request) => string;
  condition?: (req: Request) => boolean;
}

export function cacheMiddleware(options: CacheOptions) {
  return async (req: Request, res: Response, next: NextFunction) => {
    // Skip caching for non-GET requests
    if (req.method !== "GET") {
      return next();
    }

    // Check condition if provided
    if (options.condition && !options.condition(req)) {
      return next();
    }

    // Generate cache key
    const cacheKey = options.keyGenerator
      ? options.keyGenerator(req)
      : `${req.baseUrl}${req.path}:${JSON.stringify(req.query)}`;

    try {
      // Try to get from cache
      const cached = await cacheService.get(cacheKey);

      if (cached) {
        res.setHeader("X-Cache", "HIT");
        return res.json(cached);
      }

      // Cache miss - intercept response
      res.setHeader("X-Cache", "MISS");

      const originalJson = res.json.bind(res);
      res.json = function (body: any) {
        // Only cache successful responses
        if (res.statusCode >= 200 && res.statusCode < 300) {
          void cacheService.set(cacheKey, body, options.ttl);
        }
        return originalJson(body);
      };

      next();
    } catch (error) {
      console.error("[CacheMiddleware] Error:", error);
      next();
    }
  };
}

export function invalidateCache(pattern: string) {
  return async (req: Request, res: Response, next: NextFunction) => {
    res.on("finish", () => {
      if (res.statusCode >= 200 && res.statusCode < 300) {
        void cacheService.deletePattern(pattern);
      }
    });
    next();
  };
}
