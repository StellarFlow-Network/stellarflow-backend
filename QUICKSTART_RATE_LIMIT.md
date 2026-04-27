# Rate Limiting Quick Start Guide

## 🚀 5-Minute Setup

### 1. Install & Migrate

```bash
npm install
npx prisma migrate deploy
```

### 2. Configure Environment

Add to `.env`:

```bash
REDIS_URL=redis://localhost:6379
TRUST_PROXY=false
ADMIN_IP=127.0.0.1
ADMIN_API_KEY=your_secure_key_here
```

### 3. Start Server

```bash
npm run build
npm start
```

### 4. Verify

```bash
# Check config
curl http://localhost:3000/api/admin/rate-limit \
  -H "x-admin-key: your_secure_key_here" \
  -H "x-api-key: your_api_key"

# Expected response:
# {
#   "success": true,
#   "rateLimit": {
#     "windowMs": 900000,
#     "maxRequests": 100,
#     "enabled": true
#   }
# }
```

---

## 📖 Common Tasks

### Change Rate Limit

```bash
curl -X PUT http://localhost:3000/api/admin/rate-limit \
  -H "x-admin-key: $ADMIN_KEY" \
  -H "x-api-key: $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"maxRequests": 200}'
```

### Disable Rate Limiting (Emergency)

```bash
curl -X PUT http://localhost:3000/api/admin/rate-limit \
  -H "x-admin-key: $ADMIN_KEY" \
  -H "x-api-key: $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"enabled": false}'
```

### Whitelist a Relayer IP

```sql
UPDATE "Relayer"
SET "whitelistedIps" = ARRAY['203.0.113.10']
WHERE name = 'my-relayer';
```

Then refresh:

```bash
curl -X POST http://localhost:3000/api/admin/rate-limit/whitelist/refresh \
  -H "x-admin-key: $ADMIN_KEY" \
  -H "x-api-key: $API_KEY"
```

---

## 🔍 Troubleshooting

### Rate Limiting Not Working?

1. Check Redis: `redis-cli ping`
2. Check logs for: `[RateLimit] Redis unavailable`
3. Verify `rateLimit.enabled: true` in `config.json`

### IP Still Rate-Limited?

1. Check IP is in `Relayer.whitelistedIps` or matches `ADMIN_IP`
2. Force refresh: `POST /api/admin/rate-limit/whitelist/refresh`
3. Check logs for: `[RateLimit] Failed to refresh IP whitelist cache`

### Config Changes Not Taking Effect?

1. Verify `config.json` is valid JSON
2. Use admin API instead of editing file directly
3. Check file permissions

---

## 📚 Full Documentation

- **Implementation Guide:** `RATE_LIMIT_IMPLEMENTATION.md`
- **Summary:** `SECURITY_HARDENING_SUMMARY.md`
- **Complete Reference:** `IMPLEMENTATION_COMPLETE.md`

---

**That's it! You're protected from DDoS attacks.** 🛡️
