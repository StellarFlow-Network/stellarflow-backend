# Global Retry Logic Implementation

## Overview

This document describes the implementation of global retry logic for API fetchers to prevent data gaps and when external APIs experience temporary glitches.

## Issue Reference

- **Issue**: #62 - [RELIABILITY] Implement a Global "Retry" Logic
- **Branch**: `feature/global-retry-logic-62`

## Implementation Details

### Retry Utility (`src/utils/retryUtil.ts`)

A centralized retry utility has been created that provides:

1. **Automatic retry logic** for failed HTTP requests
2. **Configurable retry parameters**:
   - Maximum number of retries (default: 3)
   - Delay between retries (default: 1000ms)
   - Optional exponential backoff
   - Customizable retryable status codes
3. **Two usage patterns**:
   - `withRetry()` - Wraps individual requests
   - `createRetryableAxiosInstance()` - Creates axios instance with built-in retry

### Default Configuration

```typescript
{
  maxRetries: 3,
  retryDelay: 1000, // 1 second
  exponentialBackoff: false,
  retryableStatusCodes: [408, 429, 500, 502, 503, 504]
}
```

### Retryable Conditions

The utility automatically retries requests when:

- Network errors occur (no response received)
- Server returns retryable status codes:
  - `408` - Request Timeout
  - `429` - Too Many Requests
  - `500` - Internal Server Error
  - `502` - Bad Gateway
  - `503` - Service Unavailable
  - `504` - Gateway Timeout

## Updated Services

### 1. CoinGecko Fetcher (`src/services/marketRate/coingeckoFetcher.ts`)

```typescript
const response = await withRetry(() => axios.get(CoinGeckoFetcher.API_URL), {
  maxRetries: 3,
  retryDelay: 1000,
  onRetry: (attempt, error, delay) => {
    console.debug(`CoinGecko API retry attempt ${attempt}/3...`);
  },
});
```

### 2. GHS Fetcher (`src/services/marketRate/ghsFetcher.ts`)

All API calls wrapped with retry logic:

- CoinGecko direct GHS price
- CoinGecko XLM/USD price
- ExchangeRate API (USD to GHS)
- Alternative XLM pricing sources

### 3. KES Fetcher (`src/services/marketRate/kesFetcher.ts`)

Replaced custom retry implementation with centralized utility:

- Binance Spot API
- Binance P2P API
- Central Bank of Kenya API
- Alternative rate sources

**Note**: KES fetcher maintains its Circuit Breaker pattern for additional reliability.

### 4. NGN Fetcher (`src/services/marketRate/ngnFetcher.ts`)

All API calls wrapped with retry logic:

- VTpass API
- CoinGecko direct NGN price
- CoinGecko XLM/USD price
- ExchangeRate API (USD to NGN)

### 5. Webhook Service (`src/services/webhook.ts`)

Webhook notifications now retry on failure:

- Error notifications
- Manual review notifications

## Usage Examples

### Basic Usage

```typescript
import { withRetry } from "../utils/retryUtil.js";

const response = await withRetry(
  () => axios.get("https://api.example.com/data"),
  { maxRetries: 3, retryDelay: 1000 },
);
```

### With Custom Retry Logic

```typescript
const response = await withRetry(
  () => axios.get("https://api.example.com/data"),
  {
    maxRetries: 5,
    retryDelay: 2000,
    exponentialBackoff: true,
    shouldRetry: (error) => {
      // Custom logic to determine if retry should happen
      return error.response?.status === 503;
    },
    onRetry: (attempt, error, delay) => {
      console.log(`Retry ${attempt} after ${delay}ms`);
    },
  },
);
```

### Creating a Retryable Axios Instance

```typescript
import { createRetryableAxiosInstance } from "../utils/retryUtil.js";

const client = createRetryableAxiosInstance(
  { timeout: 5000 },
  { maxRetries: 3, retryDelay: 1000 },
);

// All requests automatically retry
const response = await client.get("https://api.example.com/data");
```

## Benefits

1. **Prevents Data Gaps**: Temporary API glitches (1-second outages) are automatically handled
2. **Consistent Behavior**: All fetchers use the same retry logic
3. **Configurable**: Easy to adjust retry parameters per service
4. **Maintainable**: Centralized implementation reduces code duplication
5. **Observable**: Debug logging for all retry attempts
6. **Resilient**: Handles network errors and server failures gracefully

## Testing

The retry logic has been integrated into existing fetchers without breaking changes. All existing tests should continue to pass.

To test retry behavior manually:

1. Temporarily disable an API endpoint
2. Observe retry attempts in logs
3. Verify the service recovers when API becomes available

## Future Enhancements

Potential improvements for future iterations:

- Add metrics/monitoring for retry attempts
- Implement adaptive retry delays based on API response headers
- Add circuit breaker pattern to other fetchers
- Create retry statistics dashboard

## Migration Guide

For adding retry logic to new fetchers:

1. Import the utility:

```typescript
import { withRetry } from "../../utils/retryUtil.js";
```

2. Wrap axios calls:

```typescript
const response = await withRetry(() => axios.get(url, config), {
  maxRetries: 3,
  retryDelay: 1000,
});
```

3. Add custom retry callback (optional):

```typescript
{
  onRetry: (attempt, error, delay) => {
    console.debug(`Retry ${attempt}/3 after ${delay}ms`);
  };
}
```

## Related Files

- `src/utils/retryUtil.ts` - Core retry utility
- `src/services/marketRate/coingeckoFetcher.ts` - CoinGecko implementation
- `src/services/marketRate/ghsFetcher.ts` - GHS implementation
- `src/services/marketRate/kesFetcher.ts` - KES implementation
- `src/services/marketRate/ngnFetcher.ts` - NGN implementation
- `src/services/webhook.ts` - Webhook implementation
