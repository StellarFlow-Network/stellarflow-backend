# Redis Caching Layer Documentation

## Overview

The StellarFlow backend implements a comprehensive multi-level caching strategy to optimize API performance and reduce database load. The caching layer consists of:

- **L1 Cache**: In-memory LRU cache (30-second TTL)
- **L2 Cache**: Redis distributed cache (5-30 minute TTL)
- **Database**: Source of truth

## Architecture

```
Request → L1 Cache (In-Memory) → L2 Cache (Redis) → Database
                ↓                      ↓                ↓
            30s TTL              5-30min TTL      Source of Truth
```

## Cache Configuration

### TTL Settings

Located in `src/config/redis.config.ts`:

```typescript
ttl: {
  marketRates: 300,      // 5 minutes
  history: 1800,         // 30 minutes
  stats: 600,            // 10 minutes
  intelligence: 900,     // 15 minutes
  assets: 1800,          // 30 minutes
  derivedAssets: 300,    // 5 minutes
  status: 60,            // 1 minute
}
```

### L1 Cache Settings

- **Max Size**: 100 entries
- **TTL**: 30 seconds
- **Eviction Policy**: LRU (Least Recently Used)

### L2 Cache (Redis) Settings

- **Max Memory**: 256MB
- **Eviction Policy**: allkeys-lru
- **Key Prefix**: `stellarflow:`

## Cache Keys

All cache keys follow a consistent naming pattern:

```typescript
CACHE_KEYS = {
  marketRates: {
    all: () => "market-rates:all",
    single: (currency) => `market-rates:${currency}`,
    latest: () => "market-rates:latest",
    health: () => "market-rates:health",
    currencies: () => "market-rates:currencies",
    pendingReviews: () => "market-rates:reviews:pending",
  },
  history: {
    asset: (asset, range) => `history:${asset}:${range}`,
  },
  stats: {
    volume: (date) => `stats:volume:${date}`,
  },
  derivedAssets: {
    crossRate: (base, quote) => `derived:${base}:${quote}`,
    ngnGhs: () => "derived:ngn-ghs",
  },
  assets: {
    all: () => "assets:all",
  },
}
```

## Usage

### Using Cache Middleware

Apply caching to any GET route:

```typescript
import { cacheMiddleware } from "../cache/CacheMiddleware";
import { CACHE_CONFIG, CACHE_KEYS } from "../config/redis.config";

router.get(
  "/rate/:currency",
  cacheMiddleware({
    ttl: CACHE_CONFIG.ttl.marketRates,
    keyGenerator: (req) => CACHE_KEYS.marketRates.single(req.params.currency),
  }),
  getRate
);
```

### Using Cache Service Directly

```typescript
import { cacheService } from "../cache/CacheService";

// Get from cache
const data = await cacheService.get<MyType>("my-key");

// Set in cache
await cacheService.set("my-key", data, 300);

// Delete from cache
await cacheService.delete("my-key");

// Delete by pattern
await cacheService.deletePattern("market-rates:*");
```

### Using Cacheable Decorator

```typescript
import { Cacheable } from "../decorators/Cacheable";

class MyService {
  @Cacheable({
    key: (userId: string) => `user:${userId}`,
    ttl: 300,
  })
  async getUserData(userId: string) {
    return await database.getUser(userId);
  }
}
```

## Cache Invalidation

### Event-Based Invalidation

```typescript
import { CacheInvalidation } from "../cache/CacheInvalidation";

// Invalidate on market rate update
await CacheInvalidation.onMarketRateUpdate("NGN");

// Invalidate on price review update
await CacheInvalidation.onPriceReviewUpdate();

// Invalidate on asset update
await CacheInvalidation.onAssetUpdate();

// Clear all caches
await CacheInvalidation.clearAll();
```

### Middleware-Based Invalidation

Automatically invalidate cache after successful mutations:

```typescript
import { invalidateCache } from "../cache/CacheMiddleware";

router.post(
  "/reviews/:id/approve",
  invalidateCache("market-rates:*"),
  approveReview
);
```

## Monitoring

### Cache Metrics Endpoint

```bash
GET /api/v1/cache/metrics
```

Response:
```json
{
  "success": true,
  "data": {
    "hits": 1250,
    "misses": 150,
    "l1Hits": 800,
    "l2Hits": 450,
    "errors": 0,
    "total": 1400,
    "hitRate": "89.29%",
    "l1Size": 45,
    "redis": {
      "connected": true
    }
  }
}
```

### Cache Health Check

```bash
GET /api/v1/cache/health
```

Response:
```json
{
  "success": true,
  "data": {
    "l1Cache": { "healthy": true },
    "l2Cache": { "healthy": true, "connected": true }
  }
}
```

### Clear Cache

```bash
POST /api/v1/cache/clear
```

## Performance Targets

### Before Caching
- GET /api/v1/market-rates/rates: ~450ms
- GET /api/v1/history/NGN: ~200ms
- GET /api/v1/stats/volume: ~800ms

### After Caching
- GET /api/v1/market-rates/rates: <50ms (9x faster)
- GET /api/v1/history/NGN: <30ms (6x faster)
- GET /api/v1/stats/volume: <80ms (10x faster)

### Target Metrics
- **Cache Hit Rate**: >80%
- **Response Time Improvement**: 10x
- **Database Query Reduction**: 90%
- **Redis Memory Usage**: <256MB

## Cache Headers

All cached responses include an `X-Cache` header:

- `X-Cache: HIT` - Response served from cache
- `X-Cache: MISS` - Response fetched from database and cached

## Graceful Degradation

The caching layer is designed to fail gracefully:

1. If Redis is unavailable, requests fall through to the database
2. L1 cache continues to work even if Redis is down
3. No errors are thrown to the client
4. Metrics track cache errors for monitoring

## Docker Setup

Redis is included in `docker-compose.yml`:

```yaml
redis:
  image: redis:7-alpine
  ports:
    - "6379:6379"
  volumes:
    - redis_data:/data
  command: redis-server --maxmemory 256mb --maxmemory-policy allkeys-lru
  healthcheck:
    test: ["CMD", "redis-cli", "ping"]
    interval: 10s
    timeout: 5s
    retries: 5
```

## Environment Variables

Add to `.env`:

```bash
REDIS_URL=redis://localhost:6379
```

For Docker:
```bash
REDIS_URL=redis://redis:6379
```

## Testing

Run cache integration tests:

```bash
npm run test:jest -- cache.test.ts
```

## Best Practices

1. **Use appropriate TTLs**: Frequently changing data should have shorter TTLs
2. **Invalidate on mutations**: Always invalidate related caches when data changes
3. **Monitor hit rates**: Aim for >80% cache hit rate
4. **Use pattern deletion carefully**: Pattern matching can be expensive
5. **Set memory limits**: Prevent Redis from consuming too much memory
6. **Handle Redis failures**: Always implement graceful degradation

## Troubleshooting

### Redis Connection Issues

Check Redis connection:
```bash
redis-cli ping
```

Check logs:
```bash
docker logs stellarflow-redis
```

### Low Hit Rate

1. Check if TTLs are too short
2. Verify cache keys are consistent
3. Check if invalidation is too aggressive
4. Monitor cache metrics endpoint

### High Memory Usage

1. Reduce TTLs for less critical data
2. Decrease maxmemory setting
3. Review cache key patterns for duplicates
4. Consider implementing cache warming selectively

## Future Enhancements

- [ ] Cache warming on startup
- [ ] Distributed cache invalidation (pub/sub)
- [ ] Cache compression for large payloads
- [ ] Advanced cache strategies (write-through, write-behind)
- [ ] Per-user cache quotas
- [ ] Cache analytics dashboard
