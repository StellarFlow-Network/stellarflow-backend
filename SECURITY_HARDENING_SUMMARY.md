# Security Hardening Implementation Summary

## Issue #205: Dynamic Rate-Limit & IP Throttling

### ✅ Implementation Complete

This implementation adds enterprise-grade DDoS protection and API throttling to the StellarFlow Oracle backend.

---

## 🎯 Requirements Met

### ✅ 1. Distributed Throttling with Redis

- **Package:** `rate-limit-redis@4.2.0` integrated with `express-rate-limit@8.3.1`
- **Store:** Redis-backed distributed store with automatic fallback to in-memory store
- **Graceful degradation:** Works without Redis (logs warning, uses local memory)
- **Key prefix:** `rl:` for all rate-limit keys in Redis
- **Auto-expiry:** Keys expire automatically after the configured window

### ✅ 2. Real-Time Configuration via Admin Dashboard

**New Admin Endpoints:**

| Endpoint                                  | Method | Purpose                          |
| ----------------------------------------- | ------ | -------------------------------- |
| `/api/admin/rate-limit`                   | GET    | View current rate-limit config   |
| `/api/admin/rate-limit`                   | PUT    | Update config in real-time       |
| `/api/admin/rate-limit/whitelist/refresh` | POST   | Force-refresh IP whitelist cache |

**Configuration Fields:**

```typescript
{
  windowMs: number; // Rolling window in milliseconds (1000–86400000)
  maxRequests: number; // Max requests per IP per window (1–100000)
  enabled: boolean; // Global throttling toggle
}
```

**Defaults:**

- `windowMs`: 900000 (15 minutes)
- `maxRequests`: 100
- `enabled`: true

**Persistence:**

- Changes are applied immediately (no restart required)
- Config is persisted to `config.json` for restart survival
- Hot-reload via `configWatcher` when `config.json` is edited manually

### ✅ 3. Whitelisted Relayer IPs Excluded from Rate Limits

**Database Schema:**

- Added `whitelistedIps: String[]` field to `Relayer` model
- Migration: `20260425124245_add_relayer_ip_whitelist`

**Whitelist Behavior:**

- Admin IP (`ADMIN_IP` env var) is automatically whitelisted
- Active relayers (`isActive=true`) with `whitelistedIps` are whitelisted
- IPv4-mapped IPv6 addresses (`::ffff:1.2.3.4`) are normalized to plain IPv4
- Whitelist cache refreshes every 60 seconds (configurable via `WHITELIST_REFRESH_MS`)
- Manual refresh available via admin API

**IP Resolution:**

- Respects `X-Forwarded-For` when `TRUST_PROXY=true` (for reverse proxy deployments)
- Falls back to `req.ip` when `TRUST_PROXY=false` (default)

---

## 📁 Files Changed/Created

### New Files

1. **`RATE_LIMIT_IMPLEMENTATION.md`** - Comprehensive documentation
2. **`SECURITY_HARDENING_SUMMARY.md`** - This file
3. **`scripts/test-rate-limit.ts`** - Test suite for rate-limit functionality
4. **`prisma/migrations/20260425124245_add_relayer_ip_whitelist/migration.sql`** - DB migration

### Modified Files

1. **`src/middleware/rateLimitMiddleware.ts`** - Complete rewrite with Redis store, dynamic config, IP whitelist
2. **`src/config/configWatcher.ts`** - Added `RateLimitConfig` interface and nested config merge
3. **`src/routes/admin.ts`** - Added 3 new admin endpoints for rate-limit management
4. **`src/app.ts`** - Updated API index with new admin endpoints
5. **`config.json`** - Added `rateLimit` configuration block
6. **`prisma/schema.prisma`** - Added `whitelistedIps` field to `Relayer` model
7. **`.env.example`** - Added `TRUST_PROXY` documentation
8. **`src/utils/envValidator.ts`** - Added `REDIS_URL` and `TRUST_PROXY` to recommended vars
9. **`package.json`** - Added `rate-limit-redis@4.2.0` dependency

---

## 🚀 Deployment Checklist

### 1. Install Dependencies

```bash
npm install
```

### 2. Run Database Migration

```bash
# Development
npx prisma migrate dev

# Production
npx prisma migrate deploy
```

### 3. Update Environment Variables

Add to `.env`:

```bash
# Required for distributed rate limiting
REDIS_URL=redis://localhost:6379

# Set to "true" if behind reverse proxy (nginx, AWS ALB, etc.)
TRUST_PROXY=false

# Admin IP (automatically whitelisted)
ADMIN_IP=127.0.0.1
ADMIN_API_KEY=your_admin_key_here
```

### 4. Configure Rate Limits

Edit `config.json` or use the admin API:

```json
{
  "rateLimit": {
    "windowMs": 900000,
    "maxRequests": 100,
    "enabled": true
  }
}
```

### 5. Add Relayer IP Whitelists (Optional)

```sql
UPDATE "Relayer"
SET "whitelistedIps" = ARRAY['203.0.113.10', '203.0.113.11']
WHERE name = 'primary-relayer';
```

### 6. Restart Server

```bash
npm run build
npm start
```

---

## 🧪 Testing

### Manual Testing

```bash
# Test rate limit enforcement
tsx scripts/test-rate-limit.ts

# Test admin API
curl -X GET http://localhost:3000/api/admin/rate-limit \
  -H "x-admin-key: your_admin_key" \
  -H "x-api-key: your_api_key"

# Update config
curl -X PUT http://localhost:3000/api/admin/rate-limit \
  -H "x-admin-key: your_admin_key" \
  -H "x-api-key: your_api_key" \
  -H "Content-Type: application/json" \
  -d '{"maxRequests": 200}'
```

### Automated Testing

```bash
# Send 101 requests (should get 429 on the 101st)
for i in {1..101}; do
  curl -s -o /dev/null -w "%{http_code}\n" \
    -H "x-api-key: your_api_key" \
    http://localhost:3000/api/v1/market-rates/rates
done
```

---

## 📊 Monitoring

### Rate Limit Headers

Every response includes:

```
RateLimit-Limit: 100
RateLimit-Remaining: 95
RateLimit-Reset: 1714089600
```

### 429 Response Format

```json
{
  "success": false,
  "error": "Too many requests. Limit: 100 per 15 minutes.",
  "retryAfter": 900
}
```

### Redis Monitoring

```bash
# Check Redis connection
redis-cli ping

# View rate-limit keys
redis-cli --scan --pattern "rl:*"

# Monitor real-time commands
redis-cli monitor
```

### Application Logs

```
[RateLimit] Redis unavailable — using in-memory store
[RateLimit] Failed to refresh IP whitelist cache: <error>
[AdminRateLimit] Rate-limit config updated: {...}
```

---

## 🔒 Security Considerations

### IP Spoofing Protection

- **Without reverse proxy:** `TRUST_PROXY=false` (default) - uses `req.ip` directly
- **With reverse proxy:** `TRUST_PROXY=true` - trusts `X-Forwarded-For` header
- **Important:** Only set `TRUST_PROXY=true` if you control the reverse proxy

### Whitelist Bypass

- Admin IP is always whitelisted (cannot be rate-limited)
- Relayer IPs are whitelisted only when `isActive=true`
- Whitelist cache is refreshed every 60 seconds (stale cache window)

### DDoS Mitigation

- Distributed throttling across multiple instances (via Redis)
- Per-IP rate limiting (not per-session or per-user)
- Configurable window and max requests
- Emergency disable via `enabled: false`

---

## 🎓 Usage Examples

### Scenario 1: Under DDoS Attack

```bash
# Reduce rate limit to 10 requests per 5 minutes
curl -X PUT http://localhost:3000/api/admin/rate-limit \
  -H "x-admin-key: $ADMIN_KEY" \
  -H "x-api-key: $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"maxRequests": 10, "windowMs": 300000}'
```

### Scenario 2: Maintenance Window

```bash
# Disable rate limiting temporarily
curl -X PUT http://localhost:3000/api/admin/rate-limit \
  -H "x-admin-key: $ADMIN_KEY" \
  -H "x-api-key: $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"enabled": false}'

# Re-enable after maintenance
curl -X PUT http://localhost:3000/api/admin/rate-limit \
  -H "x-admin-key: $ADMIN_KEY" \
  -H "x-api-key: $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"enabled": true}'
```

### Scenario 3: Add New Relayer with Whitelist

```typescript
// Create relayer with whitelisted IPs
await prisma.relayer.create({
  data: {
    name: "partner-relayer",
    apiKey: "secure_api_key_here",
    isActive: true,
    allowedAssets: ["NGN", "GHS", "KES"],
    whitelistedIps: ["203.0.113.50", "203.0.113.51"],
  },
});

// Force-refresh whitelist cache
await fetch("http://localhost:3000/api/admin/rate-limit/whitelist/refresh", {
  method: "POST",
  headers: {
    "x-admin-key": ADMIN_KEY,
    "x-api-key": API_KEY,
  },
});
```

---

## 📚 Documentation

- **Full Implementation Guide:** `RATE_LIMIT_IMPLEMENTATION.md`
- **API Documentation:** Swagger UI at `/api/v1/docs`
- **Test Suite:** `scripts/test-rate-limit.ts`

---

## 🔮 Future Enhancements

- [ ] Per-endpoint rate limits (stricter limits on `/price-updates`)
- [ ] Per-relayer rate limits (in addition to global limits)
- [ ] Rate-limit metrics dashboard (Prometheus/Grafana)
- [ ] Automatic IP ban after repeated 429s
- [ ] CAPTCHA challenge for suspicious IPs
- [ ] Geo-blocking for high-risk regions
- [ ] Sliding window algorithm (more accurate than fixed window)

---

## ✅ Acceptance Criteria

| Requirement                          | Status | Notes                                         |
| ------------------------------------ | ------ | --------------------------------------------- |
| Redis-backed distributed throttling  | ✅     | `rate-limit-redis` with graceful fallback     |
| Real-time config via Admin Dashboard | ✅     | 3 new admin endpoints                         |
| Whitelisted relayer IPs excluded     | ✅     | `Relayer.whitelistedIps` + auto-refresh cache |
| Hot-reload without restart           | ✅     | `configWatcher` + admin API                   |
| IPv4/IPv6 normalization              | ✅     | `::ffff:` prefix stripped                     |
| Reverse proxy support                | ✅     | `TRUST_PROXY` + `X-Forwarded-For`             |
| Standard rate-limit headers          | ✅     | `RateLimit-*` headers                         |
| Comprehensive documentation          | ✅     | Implementation guide + test suite             |

---

**Implementation Date:** April 25, 2026  
**Issue:** #205  
**Status:** ✅ Complete and Ready for Production
