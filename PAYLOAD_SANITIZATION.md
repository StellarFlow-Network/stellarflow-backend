# Request Payload Sanitization Middleware

## Overview

This document describes the implementation of request payload sanitization for the StellarFlow backend (issue #150). The middleware prevents injection attacks and enforces strict data type validation across all price-related endpoints.

## Problem Statement

**Goal:** Prevent injection and "mangled data" from entering the pipeline.

**Key Requirements:**
- Ensure `price` values are always valid i128-compatible strings
- Validate `symbol` matches uppercase whitelist
- Prevent SQL injection, XSS, and prototype pollution attacks
- Maintain data integrity through the entire pipeline

## Solution Architecture

### 1. Validation Schema Layer (`src/middleware/validationSchemas.ts`)

Uses **Joi** for schema-based validation with the following components:

#### i128 Number Validation
- **Pattern:** `/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/`
- **Range:** -170,141,183,460,469,231,731,687,303,715,884,105,728 to 170,141,183,460,469,231,731,687,303,715,884,105,727
- **Function:** `isValidI128String()` - Validates Stellar i128 compatibility

#### Supported Currencies Whitelist
```typescript
["NGN", "GHS", "KES", "ZAR", "XLM"]
```

#### Schema Definitions

1. **`priceSchema`** - Accepts numbers or i128-compatible strings
2. **`currencySchema`** - 3-letter uppercase codes from whitelist
3. **`sourceSchema`** - Alphanumeric, max 100 characters
4. **`memoIdSchema`** - Format: `SF-CURRENCY-TIMESTAMP-SEQUENCE`
5. **`priceUpdateMultiSigRequestSchema`** - Full request object validation
6. **`signatureRequestSchema`** - Signature request validation
7. **`marketRateQuerySchema`** - Query parameter validation

### 2. Middleware Layer (`src/middleware/payloadSanitizer.ts`)

Implements Express middleware functions that use the schemas:

#### Core Middleware Functions

**`createPayloadSanitizer(schema, name, stripUnknown)`**
- Generic middleware factory
- Validates request body against Joi schema
- Logs validation failures for security auditing
- Returns 400 with detailed error messages on failure

**`sanitizeMultiSigRequest`**
- Applied to: `POST /api/v1/price-updates/multi-sig/request`
- Validates: priceReviewId, currency, rate, source, memoId
- Rejects unknown fields

**`sanitizeSignatureRequest`**
- Applied to: `POST /api/v1/price-updates/sign`
- Validates: multiSigPriceId
- Prevents signature injection

**`sanitizeMarketRateQuery`**
- Applied to: `GET /api/v1/market-rates/rate/:currency`
- Validates URL parameters (converted to body-like format)
- Normalizes currency to uppercase

**`sanitizeGenericPayload`**
- Applied globally to all requests
- Removes dangerous fields: `__proto__`, `constructor`, `prototype`, `eval`, `exec`, `system`, `shell`
- Detects suspicious patterns: `<`, `>`, script tags, etc.

**`validatePriceAndCurrency(priceField, currencyField)`**
- Middleware factory for endpoints accepting both price and currency
- Validates positive numeric price
- Validates 3-letter uppercase currency
- Normalizes data

**`logPayload`**
- Logs all incoming requests for audit trails
- Masks sensitive fields: `secret`, `password`, `token`, `apiKey`

### 3. Integration Points

Routes updated with sanitization middleware:

#### Price Updates Route (`src/routes/priceUpdates.ts`)
```typescript
router.post("/multi-sig/request", sanitizeMultiSigRequest, handler);
router.post("/sign", sanitizeSignatureRequest, handler);
```

#### Market Rates Route (`src/routes/marketRates.ts`)
```typescript
router.get("/rate/:currency", sanitizeMarketRateQuery, handler);
```

## Security Features

### Attack Prevention

| Attack Type | Prevention Method | Example |
|---|---|---|
| SQL Injection | Input whitelist + schema validation | `"NGN'; DROP TABLE prices; --"` → 400 Rejected |
| XSS/Script Injection | Alphanumeric + pattern validation | `"<script>alert('xss')</script>"` → 400 Rejected |
| Prototype Pollution | Explicit field rejection | `__proto__: { admin: true }` → 400 Rejected |
| Type Confusion | Explicit type validation | `price: "invalid"` → 400 Rejected |
| Out-of-Range Values | i128 BigInt validation | `price: "999...overflow"` → 400 Rejected |
| Unexpected Fields | `unknown(false)` in schema | Extra fields → 400 Rejected |

### Audit Trail

- All validation failures logged with:
  - Client IP address
  - Route path
  - Error details
  - Timestamp
  - Request context

### Data Normalization

- Currency codes automatically uppercased
- Decimal prices converted to string for precision
- Whitespace trimmed
- Invalid data rejected, not silently coerced

## Testing

Comprehensive test suite at `test/payloadSanitization.test.ts` covers:

1. **i128 Validation**
   - Valid: `123`, `123.45`, `1e5`, edge cases
   - Invalid: overflow, non-numeric, malformed

2. **Price Schema**
   - Valid: positive numbers and strings
   - Invalid: negative, zero, null, non-numeric

3. **Currency Schema**
   - Valid: supported codes (auto-uppercased)
   - Invalid: unsupported, numbers, wrong length

4. **Source Schema**
   - Valid: alphanumeric with limits
   - Invalid: special characters, spaces

5. **Memo ID Schema**
   - Valid: SF-XXX-1234567890-YYY format
   - Invalid: malformed, wrong currency case

6. **Multi-Sig Requests**
   - Valid: complete payload with all fields
   - Invalid: missing fields, unknown fields

7. **Injection Tests**
   - SQL injection attempts
   - XSS/script payload attempts
   - Prototype pollution attempts

Run tests:
```bash
npm run test  # or
tsx test/payloadSanitization.test.ts
```

## Installation & Deployment

### Step 1: Install Dependencies
```bash
npm install
```

The `package.json` has been updated with:
```json
{
  "dependencies": {
    "joi": "^17.11.0"
  }
}
```

### Step 2: Import Middleware in Routes
Already done in:
- `src/routes/priceUpdates.ts`
- `src/routes/marketRates.ts`

### Step 3: Test Locally
```bash
npm run test:jest  # or specific test file
tsx test/payloadSanitization.test.ts
```

### Step 4: Deploy
- No database migrations needed
- No configuration changes needed
- Middleware operates purely on HTTP request/response layer

## API Changes

### Request Validation
Requests that previously succeeded but contained malformed data now return `400 Bad Request`:

```json
{
  "success": false,
  "error": "Invalid request payload: currency: \"Currency must be one of: NGN, GHS, KES, ZAR, XLM\"",
  "details": "MultiSigRequest validation failed"
}
```

### Error Responses
- **400 Bad Request** - Validation failed
- **500 Internal Server Error** - Unexpected validation error (rare)

### Backward Compatibility
- Valid requests remain unchanged
- Only malformed/injection attempts are rejected
- Non-required fields with correct types pass through

## Configuration

Supported currencies whitelist (edit in `src/middleware/validationSchemas.ts`):
```typescript
export const SUPPORTED_CURRENCIES = ["NGN", "GHS", "KES", "ZAR", "XLM"];
```

To add new currencies:
1. Add to `SUPPORTED_CURRENCIES` array
2. Ensure Prisma `Currency` model has entry
3. Redeploy

## Monitoring & Alerts

All validation failures are logged to the audit trail. Monitor for:
- **Spike in 400 errors** - Possible injection attacks
- **Failed multi-sig requests** - Data quality issues
- **Repeated failures from same IP** - Potential attacker

## Performance Impact

- **Negligible** - Joi schemas are highly optimized
- Validation typically <1ms per request
- Errors short-circuit early

## Future Enhancements

1. **Rate Limiting by Error Type** - Throttle repeated injection attempts
2. **Geo-Blocking** - Block requests from suspicious origins
3. **Signature Verification** - Add HMAC validation for sensitive endpoints
4. **Machine Learning** - Detect anomalous patterns in price data
5. **Custom Validators** - Domain-specific validation rules

## References

- **Joi Documentation:** https://joi.dev/
- **Stellar i128:** https://developers.stellar.org/docs/smart-contracts/soroban
- **OWASP Injection Prevention:** https://owasp.org/www-community/attacks/injection_attacks
- **OWASP Prototype Pollution:** https://owasp.org/www-community/attacks/Prototype_pollution

## Support

For questions or issues about payload sanitization:
1. Check test suite in `test/payloadSanitization.test.ts`
2. Review schema definitions in `src/middleware/validationSchemas.ts`
3. Check middleware flow in `src/middleware/payloadSanitizer.ts`
4. Review route-specific integration in `src/routes/`
