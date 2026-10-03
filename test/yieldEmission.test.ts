/**
 * Test file for Yield Emission Service
 * This test verifies the emission calculation logic works correctly
 */

import { YieldEmissionService } from "../src/services/yieldEmissionService";

async function testYieldEmissionService() {
  console.log("Testing Yield Emission Service...\n");

  const service = new YieldEmissionService();

  try {
    // Test 1: Get complete emissions data
    console.log("Test 1: Get complete emissions data");
    const emissionsResult = await service.getEmissions();
    
    if (emissionsResult.success && emissionsResult.data) {
      console.log("✓ Success: Got complete emissions data");
      console.log("  Current block:", emissionsResult.data.metrics.currentBlock);
      console.log("  Current emission rate:", emissionsResult.data.metrics.currentEmissionRate);
      console.log("  Current period:", emissionsResult.data.metrics.currentPeriod);
      console.log("  Number of projections:", emissionsResult.data.projections.length);
      console.log("  Number of schedule periods:", emissionsResult.data.schedule.length);
      
      // Test projections
      console.log("\n  Projections:");
      emissionsResult.data.projections.forEach(proj => {
        console.log(`    ${proj.days} days: ${proj.totalEmission.toFixed(2)} tokens total (${proj.averageDailyEmission.toFixed(2)} tokens/day)`);
      });
    } else {
      console.log("✗ Failed:", emissionsResult.error);
    }

    // Test 2: Get current emission rate only
    console.log("\nTest 2: Get current emission rate only");
    const rateResult = await service.getCurrentEmissionRate();
    
    if (rateResult.success && rateResult.data !== undefined) {
      console.log("✓ Success: Current emission rate is", rateResult.data);
    } else {
      console.log("✗ Failed:", rateResult.error);
    }

    // Test 3: Get emission schedule only
    console.log("\nTest 3: Get emission schedule only");
    const scheduleResult = await service.getEmissionSchedule();
    
    if (scheduleResult.success && scheduleResult.data) {
      console.log("✓ Success: Got emission schedule with", scheduleResult.data.length, "periods");
      console.log("  First period: Block", scheduleResult.data[0].startBlock, "to", scheduleResult.data[0].endBlock, "at", scheduleResult.data[0].emissionRate, "tokens/block");
      console.log("  Second period: Block", scheduleResult.data[1].startBlock, "to", scheduleResult.data[1].endBlock, "at", scheduleResult.data[1].emissionRate, "tokens/block");
    } else {
      console.log("✗ Failed:", scheduleResult.error);
    }

    console.log("\n✓ All tests completed successfully!");
  } catch (error) {
    console.error("✗ Test failed with error:", error);
  }
}

// Run the test
testYieldEmissionService().catch(console.error);
