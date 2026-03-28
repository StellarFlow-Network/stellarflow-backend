import { MarketRateService } from '../src/services/marketRate';
import { normalizeDateToUTC } from '../src/utils/timeUtils';

function testUtcNormalization() {
  const input = '2026-01-01T00:00:00-05:00';
  const normalized = normalizeDateToUTC(new Date(input));
  const expected = '2026-01-01T05:00:00.000Z';
  if (normalized.toISOString() !== expected) {
    throw new Error(`UTC normalization failed (got ${normalized.toISOString()}, expected ${expected})`);
  }
  console.log('✅ UTC normalization helper passed.');
}

async function testMarketRates() {
  testUtcNormalization();
  console.log('🧪 Testing Market Rate Fetchers...\n');
  
  const service = new MarketRateService();
  
  // Test supported currencies
  console.log('📋 Supported currencies:', service.getSupportedCurrencies());
  console.log();
  
  // Test health check
  console.log('🏥 Health check:');
  const health = await service.healthCheck();
  console.log(health);
  console.log();
  
  // Test fetching KES rate
  console.log('🇰🇪 Fetching KES rate...');
  try {
    const kesResult = await service.getRate('KES');
    console.log('KES Result:', kesResult);
  } catch (error) {
    console.log('KES Error:', error);
  }
  console.log();
  
  // Test fetching GHS rate
  console.log('🇬🇭 Fetching GHS rate...');
  try {
    const ghsResult = await service.getRate('GHS');
    console.log('GHS Result:', ghsResult);
  } catch (error) {
    console.log('GHS Error:', error);
  }
  console.log();
  
  // Test fetching all rates
  console.log('📊 Fetching all rates...');
  try {
    const allRates = await service.getAllRates();
    console.log('All Rates:', allRates);
  } catch (error) {
    console.log('All Rates Error:', error);
  }
  console.log();
  
  // Test cache status
  console.log('💾 Cache status:');
  const cacheStatus = service.getCacheStatus();
  console.log(cacheStatus);
}

// Run tests
testMarketRates().catch(console.error);
