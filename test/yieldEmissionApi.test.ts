/**
 * Simple API test for Yield Emission endpoints
 * This creates a minimal Express server to test the endpoints
 */

import express from "express";
import yieldEmissionRouter from "../src/routes/yieldEmission";

const app = express();
app.use(express.json());
app.use("/api/v1/yield", yieldEmissionRouter);

const PORT = 3001;

async function testApiEndpoints() {
  console.log("Starting test server on port", PORT);
  
  const server = app.listen(PORT, () => {
    console.log("Test server started successfully\n");
  });

  // Wait a moment for server to start
  await new Promise(resolve => setTimeout(resolve, 1000));

  try {
    // Test 1: GET /api/v1/yield/emissions
    console.log("Test 1: GET /api/v1/yield/emissions");
    const response1 = await fetch(`http://localhost:${PORT}/api/v1/yield/emissions`);
    const data1 = await response1.json();
    console.log("Response:", JSON.stringify(data1, null, 2));
    console.log("✓ Endpoint 1 working\n");

    // Test 2: GET /api/v1/yield/emissions/rate
    console.log("Test 2: GET /api/v1/yield/emissions/rate");
    const response2 = await fetch(`http://localhost:${PORT}/api/v1/yield/emissions/rate`);
    const data2 = await response2.json();
    console.log("Response:", JSON.stringify(data2, null, 2));
    console.log("✓ Endpoint 2 working\n");

    // Test 3: GET /api/v1/yield/emissions/schedule
    console.log("Test 3: GET /api/v1/yield/emissions/schedule");
    const response3 = await fetch(`http://localhost:${PORT}/api/v1/yield/emissions/schedule`);
    const data3 = await response3.json();
    console.log("Response:", JSON.stringify(data3, null, 2));
    console.log("✓ Endpoint 3 working\n");

    console.log("✓ All API endpoints tested successfully!");
  } catch (error) {
    console.error("✗ API test failed:", error);
  } finally {
    server.close();
    console.log("\nTest server stopped");
  }
}

testApiEndpoints().catch(console.error);
