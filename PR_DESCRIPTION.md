# [Dev experience] Create "Mock API" for Local Development

## 🎯 Goal
Allow developers to work without needing real API keys for VTPass or Binance.

## 📋 Summary
This PR implements a mock market rate fetcher service that generates realistic test data for local development, eliminating the need for real API credentials during development and testing.

## 🔧 Changes Made

### ✨ New Features
- **Mock Rate Fetcher** (`src/services/marketRate/mockFetcher.ts`)
  - Implements the `MarketRateFetcher` interface
  - Generates plausible exchange rates for NGN, KES, and GHS currencies
  - Uses realistic base rates with configurable tolerance ranges
  - Always reports healthy status for testing scenarios

- **Environment Toggle** (`USE_MOCKS`)
  - New environment variable to enable/disable mock mode
  - Defaults to `false` (production behavior unchanged)
  - Documented in `.env.example` with clear usage instructions

### 🔄 Modified Files
- **`src/services/marketRate/marketRateService.ts`**
  - Added import for `MockRateFetcher`
  - Modified `initializeFetchers()` to check `USE_MOCKS` environment variable
  - When enabled, initializes mock fetchers instead of real API fetchers
  - Added console logging to indicate mock mode activation

- **`.env.example`**
  - Added `USE_MOCKS=false` configuration option
  - Included descriptive comment explaining the feature

- **`README.md`**
  - Updated installation section with mock mode instructions
  - Added note about setting `USE_MOCKS=true` for local development

### 🧪 Testing
- **New Test Suite** (`test/mockFetcher.test.ts`)
  - Unit tests for `MockRateFetcher` class
  - Validates realistic rate generation for all supported currencies
  - Tests health check functionality
  - Integration tests for `MarketRateService` with mock mode enabled
  - Comprehensive mocking of dependencies (StellarService, multiSigService, etc.)

### 📊 Test Coverage
```bash
# Run the new mock fetcher tests
npm run test:jest -- test/mockFetcher.test.ts

# Run existing fetcher tests to ensure no regression
npm run test:jest -- test/ghsFetcher.test.ts
npm run test:jest -- test/ngnFetcher.test.ts
```

## 🚀 Usage

### For Local Development
1. Copy environment file:
   ```bash
   cp .env.example .env
   ```

2. Enable mock mode in `.env`:
   ```env
   USE_MOCKS=true
   ```

3. Start the server:
   ```bash
   npm run dev
   ```

### API Behavior with Mock Mode
- All market rate endpoints (`/api/v1/market-rates/*`) return realistic test data
- No external API calls are made
- Socket.IO broadcasting works normally with mock data
- Price review and submission workflows function with test rates

### Production Deployment
- Ensure `USE_MOCKS=false` or remove the variable
- Real API credentials (VTPass, Binance) must be configured
- All existing functionality remains unchanged

## 🔍 Technical Details

### Mock Rate Generation
```typescript
const MOCK_RATE_BASES: Record<string, { base: number; tolerance: number }> = {
  NGN: { base: 170, tolerance: 0.1 },    // ±10% variation
  KES: { base: 16, tolerance: 0.12 },    // ±12% variation  
  GHS: { base: 1.4, tolerance: 0.16 },    // ±16% variation
};
```

### Architecture
- Mock fetchers implement the same `MarketRateFetcher` interface as real fetchers
- No changes to existing service layer or API contracts
- Clean separation between mock and production implementations

## ✅ Validation
- ✅ TypeScript compilation passes for new code
- ✅ All existing tests continue to pass
- ✅ New test suite covers mock functionality
- ✅ Environment configuration properly documented
- ✅ README updated with usage instructions
- ✅ Mock fetcher generates realistic rate data within expected ranges

## 🔗 Related Issues
- Closes #168: Create "Mock API" for Local Development

## 📈 Impact
- **Developer Experience**: Significantly improved - no more blocked development waiting for API keys
- **Testing**: Enables comprehensive integration testing without external dependencies
- **CI/CD**: Mock mode can be used in automated testing environments
- **Security**: No production impact - mock mode must be explicitly enabled

## 🏷️ Labels
- `enhancement`
- `developer-experience`
- `testing`
- `documentation`