import axios from "axios";
import dotenv from "dotenv";

dotenv.config();

const PORT = process.env.PORT || 3000;
const URL = `http://localhost:${PORT}/api`;
const KEY = process.env.API_KEY;

async function testSecurity() {
  console.log("🛡️ Testing API Security...\n");

  if (!KEY) {
    console.error("❌ KEY not found in .env. Skip tests.");
    return;
  }

  // 1. Missing key
  console.log("Testing with missing key...");
  try {
    await axios.get(`${URL}/market-rates/currencies`);
    console.error("FAIL: Allowed without key");
  } catch (err: any) {
    if (err.response?.status === 401) {
      console.log("✅ PASS: Blocked (401)");
    } else {
      console.error("FAIL: Wrong error", err.response?.status);
    }
  }

  // 2. Wrong key
  console.log("\nTesting with wrong key...");
  try {
    await axios.get(`${URL}/market-rates/currencies`, {
      headers: { "X-API-KEY": "wrong" },
    });
    console.error("FAIL: Allowed with wrong key");
  } catch (err: any) {
    if (err.response?.status === 401) {
      console.log("✅ PASS: Blocked (401)");
    } else {
      console.error("FAIL: Wrong error", err.response?.status);
    }
  }

  // 3. Correct key
  console.log("\nTesting with correct key...");
  try {
    const res = await axios.get(`${URL}/market-rates/currencies`, {
      headers: { "X-API-KEY": KEY },
    });
    console.log("✅ PASS: Allowed (200)");
  } catch (err: any) {
    console.error("FAIL: Blocked", err.message);
  }

  // 4. Docs protection check
  console.log("\nTesting docs protection...");
  try {
    await axios.get(`${URL}/docs`);
    console.error("FAIL: Docs allowed without key");
  } catch (err: any) {
    if (err.response?.status === 401) {
      console.log("✅ PASS: Docs also protected (401)");
    } else {
      console.error("FAIL: Docs wrong error", err.response?.status);
    }
  }
}

testSecurity().catch(console.error);
