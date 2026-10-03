/**
 * Simple unit test for Yield Emission Service without external dependencies
 * Tests the core business logic without Redis, Express, or other services
 */

import { YieldEmissionService } from "../src/services/yieldEmissionService";

async function testYieldEmissionLogic() {
  console.log("Testing Yield Emission Service Logic...\n");

  const service = new YieldEmissionService();

  try {
    // Set current block to an early period for meaningful test data
    // Block 100,000 would be in the first period (0-630,720)
    service.setCurrentBlock(100000);
    console.log("Test current block set to:", 100000);
    // Test 1: Get complete emissions data
    console.log("Test 1: Get complete emissions data");
    const emissionsResult = await service.getEmissions();
    
    if (emissionsResult.success && emissionsResult.data) {
      console.log("✓ Success: Got complete emissions data");
      console.log("  Current block:", emissionsResult.data.metrics.currentBlock);
      console.log("  Current emission rate:", emissionsResult.data.metrics.currentEmissionRate);
      console.log("  Current period:", emissionsResult.data.metrics.currentPeriod);
      console.log("  Next halving block:", emissionsResult.data.metrics.nextHalvingBlock);
      console.log("  Blocks until halving:", emissionsResult.data.metrics.blocksUntilHalving);
      
      // Test projections
      console.log("\n  Projections:");
      emissionsResult.data.projections.forEach(proj => {
        console.log(`    ${proj.days} days: ${proj.totalEmission.toFixed(2)} tokens total (${proj.averageDailyEmission.toFixed(2)} tokens/day)`);
        console.log(`      Periods: ${proj.startPeriod} to ${proj.endPeriod}`);
      });
      
      // Verify schedule structure
      console.log("\n  Schedule structure:");
      console.log("  Number of periods:", emissionsResult.data.schedule.length);
      console.log("  First period emission rate:", emissionsResult.data.schedule[0].emissionRate);
      console.log("  Second period emission rate:", emissionsResult.data.schedule[1].emissionRate);
      console.log("  Halving factor:", emissionsResult.data.schedule[0].halvingFactor);
      
      // Verify halving logic
      const expectedSecondRate = emissionsResult.data.schedule[0].emissionRate * emissionsResult.data.schedule[0].halvingFactor;
      if (Math.abs(emissionsResult.data.schedule[1].emissionRate - expectedSecondRate) < 0.0001) {
        console.log("  ✓ Halving logic verified correctly");
      } else {
        console.log("  ✗ Halving logic error");
      }
    } else {
      console.log("✗ Failed:", emissionsResult.error);
    }

    // Test 2: Get current emission rate only
    console.log("\nTest 2: Get current emission rate only");
    const rateResult = await service.getCurrentEmissionRate();
    
    if (rateResult.success && rateResult.data !== undefined) {
      console.log("✓ Success: Current emission rate is", rateResult.data);
      
      // Verify rate is positive
      if (rateResult.data > 0) {
        console.log("  ✓ Emission rate is positive");
      } else {
        console.log("  ✗ Emission rate should be positive");
      }
    } else {
      console.log("✗ Failed:", rateResult.error);
    }

    // Test 3: Get emission schedule only
    console.log("\nTest 3: Get emission schedule only");
    const scheduleResult = await service.getEmissionSchedule();
    
    if (scheduleResult.success && scheduleResult.data) {
      console.log("✓ Success: Got emission schedule with", scheduleResult.data.length, "periods");
      
      // Verify schedule structure
      let allValid = true;
      for (let i = 0; i < scheduleResult.data.length; i++) {
        const period = scheduleResult.data[i];
        if (period.period === undefined || period.startBlock === undefined || 
            period.endBlock === undefined || period.emissionRate === undefined) {
          console.log(`  ✗ Period ${i} has invalid structure`);
          allValid = false;
        }
        if (period.emissionRate <= 0) {
          console.log(`  ✗ Period ${i} has non-positive emission rate`);
          allValid = false;
        }
      }
      
      if (allValid) {
        console.log("  ✓ All schedule periods have valid structure");
      }
      
      // Verify block intervals
      const interval = scheduleResult.data[0].endBlock - scheduleResult.data[0].startBlock;
      console.log("  Block interval:", interval, "blocks");
      
      // Verify decreasing emission rates
      let decreasing = true;
      for (let i = 1; i < scheduleResult.data.length; i++) {
        if (scheduleResult.data[i].emissionRate >= scheduleResult.data[i-1].emissionRate) {
          decreasing = false;
          console.log(`  ✗ Emission rate not decreasing at period ${i}`);
        }
      }
      if (decreasing) {
        console.log("  ✓ Emission rates decrease correctly over periods");
      }
    } else {
      console.log("✗ Failed:", scheduleResult.error);
    }

    // Test 4: Verify projection calculations
    console.log("\nTest 4: Verify projection calculations");
    const projectionResult = await service.getEmissions();
    if (projectionResult.success && projectionResult.data) {
      const proj30 = projectionResult.data.projections.find(p => p.days === 30);
      const proj90 = projectionResult.data.projections.find(p => p.days === 90);
      const proj365 = projectionResult.data.projections.find(p => p.days === 365);
      
      if (proj30 && proj90 && proj365) {
        console.log("  ✓ All projection periods available");
        console.log(`    30-day projection: ${proj30.totalEmission.toFixed(2)} tokens`);
        console.log(`    90-day projection: ${proj90.totalEmission.toFixed(2)} tokens`);
        console.log(`    365-day projection: ${proj365.totalEmission.toFixed(2)} tokens`);
        
        // Verify that longer periods have more total emissions
        if (proj90.totalEmission > proj30.totalEmission && proj365.totalEmission > proj90.totalEmission) {
          console.log("  ✓ Total emissions increase with time periods");
        } else {
          console.log("  ✗ Total emissions should increase with time periods");
        }
        
        // Verify block counts
        const expectedBlocks30 = Math.floor((30 * 24 * 3600) / 5); // 5 seconds per block
        if (Math.abs(proj30.blocksInPeriod - expectedBlocks30) < 100) {
          console.log("  ✓ Block count calculation accurate for 30 days");
        } else {
          console.log("  ✗ Block count calculation may be incorrect");
        }
      }
    }

    // Test 5: Reset to actual block and verify
    console.log("\nTest 5: Reset to actual block and verify");
    (service as any).resetCurrentBlock();
    const actualResult = await service.getEmissions();
    if (actualResult.success && actualResult.data) {
      console.log("  ✓ Service works with actual block number");
      console.log("  Actual current block:", actualResult.data.metrics.currentBlock);
    }

    console.log("\n✓ All core logic tests completed successfully!");
  } catch (error) {
    console.error("✗ Test failed with error:", error);
  }
}

// Run the test
testYieldEmissionLogic().catch(console.error);
