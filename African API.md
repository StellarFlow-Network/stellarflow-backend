# African Exchange API Integration (NGN)

This pull request integrates a Nigerian Naira (NGN) exchange rate fetcher into the StellarFlow backend. It allows the system to provide real-time NGN/XLM market rates by aggregating data from multiple reliable sources.

## Proposed Changes

### Market Rate Service Improvements

- **New NGNRateFetcher**: Added `src/services/marketRate/ngnFetcher.ts` which implements the `MarketRateFetcher` interface. It uses a tiered strategy for robustness:
  - **Binance P2P**: Primary source for direct XLM/NGN or XLM/USDT \* USDT/NGN cross rates.
  - **CoinGecko**: Reliable aggregator for XLM/NGN.
  - **ExchangeRate API**: Fallback source for USD/NGN cross-conversion.
- **Service Registration**: Updated `src/services/marketRate/index.ts` and `src/services/marketRate/marketRateService.ts` to include and register the `NGNRateFetcher`.
- **Fault Tolerance**: The new fetcher includes a `CircuitBreaker` and exponential backoff retry logic to handle transient API failures.

## Verification Results

- Verified the API interaction logic using a standalone test script.
- Successful data retrieval confirmed for CoinGecko and ExchangeRate API.
- Unit tests added in `test/ngnFetcher.test.ts`.

issue #3
