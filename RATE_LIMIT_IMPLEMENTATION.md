# Security Hardening: Dynamic Rate-Limit & IP Throttling

## Overview

This implementation adds a configurable, Redis-backed rate-limiting layer to protect the StellarFlow Oracle from DDoS attacks and excessive API consumption. The system supports:

- **Distributed throttling** via Redis (with graceful fallback to in-memory store)
- **Real-time configuration** via Admin Dashboard API
- **IP whitelisting** for relayers and admin IPs
- **Hot-reload** from `config.json` without server restart

## Architecture

### Components

1. **Rate Limit Middleware** (`src/middleware/rateLimitMiddleware.ts`)
   - Uses `express-rate-limit` with `rate-limit-redis` store
   - Reads config from `appConfig.rateLimit` on every request (dynamic)
   - Maintains in-memory cache of whitelisted IPs (refreshed every 60s)
   - Resolves real client IP from `X-Forwarded-For` when `TRUST_PROXY=true`

2. **Config Management** (`src/config/configWatcher.ts`)
   - Extended `AppConfig` interface with `RateLimitConfig`
   - Hot-reloads `config.json` changes via `fs.watch`
   - Defaults: 100 requests per 15 minutes, enabled

3. **Database Schema** (`prisma/schema.prisma`)
   - Added `whitelistedIps: String[]` to `Relayer` model
   - Allows per-relayer IP whitelist configuration

4. **Admin API** (`src/routes/admin.ts`)
   - `GET /api/admin/rate-limit` - View current config
   - `PUT /api/admin/rate-limit` - Update config in real-time
   - `POST /api/admin/rate-limit/whitelist/refresh` - Force-refresh IP cache

## Configuration

### Environment Variables

Add to `.env`:

```bash
# Set to "true" if behind a reverse proxy (nginx, AWS ALB, etc.)
# Enables X-Forwarded-For header parsing for real client IP
TRUST_PROXY=false

# Redis URL (required for distributed rate limiting across multiple instances)
REDIS_URL=redis://localhost:6379

# Admin IP (automatically whitelisted from rate limits)
ADMIN_IP=127.0.0.1
ADMIN_API_KEY=your_admin_key_here
```

### config.json

```json
{
  "rateLimit": {
    "windowMs": 900000, // 15 minutes in milliseconds
    "maxRequests": 100, // Max requests per IP per window
    "enabled": true // Global throttling toggle
  }
}
```

## Usage

### Admin Dashboard Integration

#### Get Current Rate-Limit Config

```bash
curl -X GET http://localhost:3000/api/admin/rate-limit \
  -H "x-admin-key: your_admin_key" \
  -H "x-api-key: your_api_key"
```

Response:

```json
{
  "success": true,
  "rateLimit": {
    "windowMs": 900000,
    "maxRequests": 100,
    "enabled": true
  }
}
```

#### Update Rate-Limit Config (Real-Time)

```bash
curl -X PUT http://localhost:3000/api/admin/rate-limit \
  -H "x-admin-key: your_admin_key" \
  -H "x-api-key: your_api_key" \
  -H "Content-Type: application/json" \
  -d '{
    "maxRequests": 200,
    "windowMs": 600000,
    "enabled": true
  }'
```

Response:

```json
{
  "success": true,
  "message": "Rate-limit configuration updated",
  "rateLimit": {
    "windowMs": 600000,
    "maxRequests": 200,
    "enabled": true
  }
}
```

**Note:** Changes take effect immediately on the next request. The config is also persisted to `config.json` so it survives server restarts.

#### Disable Rate Limiting (Emergency)

```bash
curl -X PUT http://localhost:3000/api/admin/rate-limit \
  -H "x-admin-key: your_admin_key" \
  -H "x-api-key: your_api_key" \
  -H "Content-Type: application/json" \
  -d '{"enabled": false}'
```

### Relayer IP Whitelisting

#### Add Whitelisted IPs to a Relayer

Use Prisma Studio or direct SQL:

```sql
UPDATE "Relayer"
SET "whitelistedIps" = ARRAY['203.0.113.10', '203.0.113.11']
WHERE name = 'primary-relayer';
```

Or via Prisma:

```typescript
await prisma.relayer.update({
  where: { id: 1 },
  data: {
    whitelistedIps: ["203.0.113.10", "203.0.113.11"],
  },
});
```

#### Force-Refresh Whitelist Cache

After updating relayer IPs in the database:

```bash
curl -X POST http://localhost:3000/api/admin/rate-limit/whitelist/refresh \
  -H "x-admin-key: your_admin_key" \
  -H "x-api-key: your_api_key"
```

Response:

```json
{
  "success": true,
  "message": "IP whitelist cache refreshed"
}
```

**Note:** The whitelist cache auto-refreshes every 60 seconds, so manual refresh is optional.

## Deployment

### Database Migration

Run the Prisma migration to add `whitelistedIps` to the `Relayer` table:

```bash
npx prisma migrate dev --name add_relayer_ip_whitelist
```

Or for production:

```bash
npx prisma migrate deploy
```

### Redis Setup

The rate limiter requires Redis for distributed throttling across multiple server instances. If Redis is unavailable, the middleware gracefully falls back to an in-memory store (not shared across instances).

**Docker Compose:**

```yaml
services:
  redis:
    image: redis:7-alpine
    ports:
      - "6379:6379"
    volumes:
      - redis-data:/data
    command: redis-server --maxmemory 256mb --maxmemory-policy allkeys-lru

volumes:
  redis-data:
```

**Environment:**

```bash
REDIS_URL=redis://localhost:6379
```

### Reverse Proxy Configuration

If the app is behind a reverse proxy (nginx, AWS ALB, Cloudflare), set `TRUST_PROXY=true` so the middleware reads the real client IP from `X-Forwarded-For`.

**Nginx example:**

```nginx
location /api {
    proxy_pass http://localhost:3000;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Real-IP $remote_addr;
}
```

## Security Considerations

### IP Spoofing Protection

- **Without reverse proxy:** Set `TRUST_PROXY=false` (default). The middleware uses `req.ip` directly.
- **With reverse proxy:** Set `TRUST_PROXY=true` and ensure the proxy is configured to set `X-Forwarded-For` correctly. Only trust proxies you control.

### Whitelist Bypass

- Admin IP (`ADMIN_IP` env var) is automatically whitelisted
- Relayer IPs (`Relayer.whitelistedIps`) are whitelisted when `isActive=true`
- IPv4-mapped IPv6 addresses (`::ffff:1.2.3.4`) are normalized to plain IPv4 for comparison

### Rate Limit Headers

The middleware returns standard rate-limit headers:

```
RateLimit-Limit: 100
RateLimit-Remaining: 95
RateLimit-Reset: 1714089600
```

When rate limit is exceeded:

```
HTTP/1.1 429 Too Many Requests
Content-Type: application/json

{
  "success": false,
  "error": "Too many requests. Limit: 100 per 15 minutes.",
  "retryAfter": 900
}
```

## Monitoring

### Redis Store Health

Check Redis connection status:

```bash
redis-cli ping
# Expected: PONG
```

View rate-limit keys:

```bash
redis-cli --scan --pattern "rl:*"
```

### Logs

The middleware logs:

- `[RateLimit] Redis unavailable — using in-memory store` (warning)
- `[RateLimit] Failed to refresh IP whitelist cache` (error)
- `[AdminRateLimit] Rate-limit config updated: {...}` (info)

### Metrics

Rate-limit hits are tracked per IP in Redis with automatic expiry. Use Redis monitoring tools or the `/api/v1/cache` endpoint to observe cache metrics.

## Testing

### Test Rate Limiting

```bash
# Send 101 requests rapidly (should trigger 429 on the 101st)
for i in {1..101}; do
  curl -s -o /dev/null -w "%{http_code}\n" \
    -H "x-api-key: your_api_key" \
    http://localhost:3000/api/v1/market-rates/rates
done
```

### Test IP Whitelist

1. Add your IP to a relayer's `whitelistedIps`
2. Send 200 requests (should all succeed, no 429)
3. Remove your IP and retry (should get 429 after 100 requests)

### Test Dynamic Config

1. Set `maxRequests: 5` via admin API
2. Send 6 requests (should get 429 on the 6th)
3. Set `enabled: false` via admin API
4. Send 100 requests (should all succeed)

## Troubleshooting

### Rate Limiting Not Working

- Check Redis connection: `redis-cli ping`
- Verify `REDIS_URL` is set correctly
- Check logs for `[RateLimit] Redis unavailable` warning
- Ensure `rateLimit.enabled: true` in `config.json`

### Whitelisted IP Still Rate-Limited

- Verify IP is in `Relayer.whitelistedIps` or matches `ADMIN_IP`
- Check IP normalization (IPv4 vs IPv6-mapped)
- Force-refresh whitelist cache via admin API
- Check logs for `[RateLimit] Failed to refresh IP whitelist cache`

### Config Changes Not Taking Effect

- Verify `config.json` syntax is valid JSON
- Check file permissions (must be readable by the app)
- Restart the server if `configWatcher` is not running
- Use admin API to update config instead of editing `config.json` directly

## Future Enhancements

- [ ] Per-endpoint rate limits (e.g., stricter limits on `/price-updates`)
- [ ] Per-relayer rate limits (in addition to global limits)
- [ ] Rate-limit metrics dashboard (Prometheus/Grafana)
- [ ] Automatic IP ban after repeated 429s
- [ ] CAPTCHA challenge for suspicious IPs
- [ ] Geo-blocking for high-risk regions

## References

- [express-rate-limit](https://github.com/express-rate-limit/express-rate-limit)
- [rate-limit-redis](https://github.com/express-rate-limit/rate-limit-redis)
- [Redis Best Practices](https://redis.io/docs/management/optimization/)
- [OWASP Rate Limiting](https://cheatsheetseries.owasp.org/cheatsheets/Denial_of_Service_Cheat_Sheet.html#rate-limiting)
