import axios, { AxiosError } from "axios";
import { withRetry } from "../src/utils/retryUtil.js";
import * as assert from "assert";

/**
 * Test suite for retry utility
 */
async function testRetryUtil() {
  console.log("Testing retry utility...\n");

  // Test 1: Successful request on first attempt
  console.log("Test 1: Successful request on first attempt");
  try {
    let callCount = 0;
    const result = await withRetry(
      async () => {
        callCount++;
        return { data: "success" };
      },
      { maxRetries: 3, retryDelay: 100 },
    );
    assert.strictEqual(
      callCount,
      1,
      "Should only call once for successful request",
    );
    assert.deepStrictEqual(result, { data: "success" });
    console.log("✅ PASS\n");
  } catch (error) {
    console.error("❌ FAIL:", error);
    process.exit(1);
  }

  // Test 2: Retry on network error
  console.log("Test 2: Retry on network error");
  try {
    let callCount = 0;
    const result = await withRetry(
      async () => {
        callCount++;
        if (callCount < 3) {
          const error = new Error("Network error") as AxiosError;
          error.isAxiosError = true;
          error.config = {} as any;
          throw error;
        }
        return { data: "success after retries" };
      },
      { maxRetries: 3, retryDelay: 100 },
    );
    assert.strictEqual(callCount, 3, "Should retry until success");
    assert.deepStrictEqual(result, { data: "success after retries" });
    console.log("✅ PASS\n");
  } catch (error) {
    console.error("❌ FAIL:", error);
    process.exit(1);
  }

  // Test 3: Exhaust all retries
  console.log("Test 3: Exhaust all retries");
  try {
    let callCount = 0;
    try {
      await withRetry(
        async () => {
          callCount++;
          const error = new Error("Persistent error") as AxiosError;
          error.isAxiosError = true;
          error.config = {} as any;
          throw error;
        },
        { maxRetries: 3, retryDelay: 100 },
      );
      console.error("❌ FAIL: Should have thrown error");
      process.exit(1);
    } catch (error) {
      assert.strictEqual(callCount, 4, "Should call 1 initial + 3 retries");
      console.log("✅ PASS (correctly threw error after exhausting retries)\n");
    }
  } catch (error) {
    console.error("❌ FAIL:", error);
    process.exit(1);
  }

  // Test 4: Retry on 503 status code
  console.log("Test 4: Retry on 503 status code");
  try {
    let callCount = 0;
    const result = await withRetry(
      async () => {
        callCount++;
        if (callCount < 2) {
          const error = new Error("Service unavailable") as AxiosError;
          error.isAxiosError = true;
          error.config = {} as any;
          error.response = {
            status: 503,
            statusText: "Service Unavailable",
            data: {},
            headers: {},
            config: {} as any,
          };
          throw error;
        }
        return { data: "recovered" };
      },
      { maxRetries: 3, retryDelay: 100 },
    );
    assert.strictEqual(callCount, 2, "Should retry once on 503");
    assert.deepStrictEqual(result, { data: "recovered" });
    console.log("✅ PASS\n");
  } catch (error) {
    console.error("❌ FAIL:", error);
    process.exit(1);
  }

  // Test 5: Don't retry on 404 (not retryable)
  console.log("Test 5: Don't retry on 404 (not retryable)");
  try {
    let callCount = 0;
    try {
      await withRetry(
        async () => {
          callCount++;
          const error = new Error("Not found") as AxiosError;
          error.isAxiosError = true;
          error.config = {} as any;
          error.response = {
            status: 404,
            statusText: "Not Found",
            data: {},
            headers: {},
            config: {} as any,
          };
          throw error;
        },
        { maxRetries: 3, retryDelay: 100 },
      );
      console.error("❌ FAIL: Should have thrown error");
      process.exit(1);
    } catch (error) {
      assert.strictEqual(callCount, 1, "Should not retry on 404");
      console.log("✅ PASS (correctly didn't retry on 404)\n");
    }
  } catch (error) {
    console.error("❌ FAIL:", error);
    process.exit(1);
  }

  // Test 6: Custom shouldRetry function
  console.log("Test 6: Custom shouldRetry function");
  try {
    let callCount = 0;
    const result = await withRetry(
      async () => {
        callCount++;
        if (callCount < 2) {
          const error = new Error("Custom error") as AxiosError;
          error.isAxiosError = true;
          error.config = {} as any;
          error.response = {
            status: 418,
            statusText: "I'm a teapot",
            data: {},
            headers: {},
            config: {} as any,
          };
          throw error;
        }
        return { data: "custom retry worked" };
      },
      {
        maxRetries: 3,
        retryDelay: 100,
        shouldRetry: (error) => error.response?.status === 418,
      },
    );
    assert.strictEqual(callCount, 2, "Should retry on custom condition");
    assert.deepStrictEqual(result, { data: "custom retry worked" });
    console.log("✅ PASS\n");
  } catch (error) {
    console.error("❌ FAIL:", error);
    process.exit(1);
  }

  // Test 7: onRetry callback
  console.log("Test 7: onRetry callback");
  try {
    let callCount = 0;
    let retryCallbackCount = 0;
    const result = await withRetry(
      async () => {
        callCount++;
        if (callCount < 3) {
          const error = new Error("Retry test") as AxiosError;
          error.isAxiosError = true;
          error.config = {} as any;
          throw error;
        }
        return { data: "callback test" };
      },
      {
        maxRetries: 3,
        retryDelay: 100,
        onRetry: (attempt, error, delay) => {
          retryCallbackCount++;
          assert.strictEqual(delay, 100, "Delay should be 100ms");
        },
      },
    );
    assert.strictEqual(
      retryCallbackCount,
      2,
      "Callback should be called for each retry",
    );
    console.log("✅ PASS\n");
  } catch (error) {
    console.error("❌ FAIL:", error);
    process.exit(1);
  }

  console.log("✅ All retry utility tests passed!");
}

// Run tests
testRetryUtil().catch((error) => {
  console.error("Test suite failed:", error);
  process.exit(1);
});
