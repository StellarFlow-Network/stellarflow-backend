# MiddleValuePriceService

## Overview

The `MiddleValuePriceService` is a new service that improves price accuracy by waiting for 3 different API responses before calculating the price. It uses the **middle value (median)** of the three sources to reduce the impact of a single "rogue" API source.

## Problem Solved

In the existing system, if one API source returns an incorrect or manipulated price, it can skew the final calculated price. This service solves that by:

1. **Waiting for multiple sources** - Requires at least 3 successful API responses
2. **Using the median value** - Eliminates the impact of extreme outliers
3. **Reducing rogue API impact** - A single bad source won't affect the final price

## How It Works

### Example Scenario

If three API sources return these NGN prices:
- Source 1: 1580 NGN
- Source 2: 1600 NGN  
- Source 3: 1620 NGN

The middle value is **1600 NGN** (the median).

### With a Rogue Source

If one source is compromised or returns bad data:
- Source 1: 750 NGN
- Source 2: 752 NGN
- Source 3: 900 NGN (rogue/manipulated)

The middle value is **752 NGN** - the rogue 900 NGN is automatically ignored!

## Installation & Usage

The service is already part of the `src/services/marketRate/` module and exported through the index.

### Basic Usage

```typescript
import { MiddleValuePriceService } from "./src/services/marketRate/middleValuePriceService.js";

const service = new MiddleValuePriceService();

// Define 3 price sources
const priceSources = [
  async () => ({ rate: 1580, timestamp: new Date() }),
  async () => ({ rate: 1600, timestamp: new Date() }),
  async () => ({ rate: 1620, timestamp: new Date() }),
];

// Fetch the middle value price
const result = await service.fetchMiddleValuePrice(
  priceSources,
  "NGN",
  10000 // 10 second timeout
);

console.log(result.rate); // Output: 1600
```

### Using Built-in Source Helpers

The service provides helper methods to create price sources from common APIs:

```typescript
const service = new MiddleValuePriceService();

const priceSources = [
  // CoinGecko API
  service.createCoinGeckoSource(
    "https://api.coingecko.com/api/v3/simple/price?ids=stellar&vs_currencies=ngn",
    "ngn"
  ),
  
  // ExchangeRate API
  service.createExchangeRateSource(
    "https://open.er-api.com/v6/latest/USD",
    "NGN"
  ),
  
  // Custom API
  service.createCustomSource(
    "https://your-api.com/rates/NGN",
    (data) => data.rate,
    (data) => new Date(data.timestamp)
  ),
];

const result = await service.fetchMiddleValuePrice(priceSources, "NGN");
```

## Integration with Existing Fetchers

You can integrate this service with the existing NGN, KES, and GHS fetchers:

```typescript
import { MiddleValuePriceService } from "./src/services/marketRate/middleValuePriceService.js";
import { NGNRateFetcher } from "./src/services/marketRate/ngnFetcher.js";

const middleValueService = new MiddleValuePriceService();
const ngnFetcher = new NGNRateFetcher();

// Create 3 sources using different approaches
const priceSources = [
  // Source 1: Direct from NGN fetcher
  async () => {
    const rate = await ngnFetcher.fetchRate();
    return { rate: rate.rate, timestamp: rate.timestamp };
  },
  
  // Source 2: ExchangeRate API (USD to NGN) * CoinGecko XLM/USD
  async () => {
    // Call ExchangeRate API directly
    const usdToNgn = await fetchExchangeRate();
    const xlmToUsd = await fetchCoinGecko();
    return { rate: usdToNgn * xlmToUsd, timestamp: new Date() };
  },
  
  // Source 3: VTpass or another exchange
  async () => {
    const rate = await fetchVtpassRate();
    return { rate, timestamp: new Date() };
  },
];

const result = await middleValueService.fetchMiddleValuePrice(priceSources, "NGN");
```

## API Reference

### `fetchMiddleValuePrice(sources, currency, timeoutMs?)`

Fetches prices from multiple sources and returns the middle value.

**Parameters:**
- `sources`: Array of functions that fetch prices (minimum 3 required)
- `currency`: Currency code (e.g., 'NGN', 'KES', 'GHS')
- `timeoutMs`: Maximum time to wait for all sources (default: 10000ms)

**Returns:**
- `Promise<MarketRate>` - The calculated middle value price

**Throws:**
- Error if less than 3 sources are provided
- Error if less than 3 sources succeed

### `createCoinGeckoSource(coinGeckoUrl, currencyCode)`

Creates a price source function for CoinGecko API.

**Parameters:**
- `coinGeckoUrl`: The CoinGecko API URL
- `currencyCode`: The currency code (e.g., 'ngn', 'kes', 'ghs')

**Returns:**
- Function that fetches price from CoinGecko

### `createExchangeRateSource(exchangeRateUrl, currencyCode)`

Creates a price source function for ExchangeRate API.

**Parameters:**
- `exchangeRateUrl`: The ExchangeRate API URL
- `currencyCode`: The currency code (e.g., 'NGN', 'KES', 'GHS')

**Returns:**
- Function that fetches price from ExchangeRate API

### `createCustomSource(url, extractRate, extractTimestamp?)`

Creates a price source function for any custom API.

**Parameters:**
- `url`: The API URL
- `extractRate`: Function to extract rate from response data
- `extractTimestamp`: Optional function to extract timestamp from response data

**Returns:**
- Function that fetches price from custom API

## Testing

Run the test suite:

```bash
npx tsx test/middleValuePriceService.test.ts
```

The tests cover:
- ✅ Middle value calculation with 3 prices
- ✅ Middle value calculation with outliers
- ✅ Middle value calculation with 5 prices
- ✅ Middle value calculation with even number of prices
- ✅ Integration test with mocked sources
- ✅ Handling of failing sources
- ✅ Error handling when too few sources succeed

## Examples

See `examples/middleValuePriceExample.ts` for complete usage examples:

```bash
npx tsx examples/middleValuePriceExample.ts
```

## Benefits Over Current Approach

| Feature | Current Approach | MiddleValuePriceService |
|---------|------------------|------------------------|
| Sources Required | Uses whatever responds | Requires 3+ sources |
| Outlier Handling | IQR filtering | Median (automatic outlier rejection) |
| Rogue API Protection | Partial | **Full** (middle value ignores extremes) |
| Timeout Control | Per-source | Global timeout for all sources |
| Failure Tolerance | Varies | Requires minimum 3 successes |

## Architecture

```
┌─────────────────────────────────────────┐
│   MiddleValuePriceService               │
│                                         │
│  ┌─────────┐  ┌─────────┐  ┌─────────┐ │
│  │Source 1 │  │Source 2 │  │Source 3 │ │
│  │  API    │  │  API    │  │  API    │ │
│  └────┬────┘  └────┬────┘  └────┬────┘ │
│       │            │            │       │
│       └────────────┴────────────┘       │
│                    │                    │
│              ┌─────▼─────┐             │
│              │  Sort &   │             │
│              │  Median   │             │
│              └─────┬─────┘             │
│                    │                    │
│              ┌─────▼─────┐             │
│              │  Result   │             │
│              │  Price    │             │
│              └───────────┘             │
└─────────────────────────────────────────┘
```

## Future Enhancements

- [ ] Add caching for successful source responses
- [ ] Implement dynamic source selection based on reliability
- [ ] Add webhook notifications when rogue sources are detected
- [ ] Support configurable minimum source count (2-5)
- [ ] Add source health tracking and automatic exclusion of unhealthy sources

## Related Files

- Service: `src/services/marketRate/middleValuePriceService.ts`
- Tests: `test/middleValuePriceService.test.ts`
- Examples: `examples/middleValuePriceExample.ts`
- Types: `src/services/marketRate/types.ts`
