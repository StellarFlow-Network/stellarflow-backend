import assert from "node:assert/strict";
import {
  validateSchema,
  priceUpdateMultiSigRequestSchema,
  signatureRequestSchema,
  marketRateQuerySchema,
  derivedAssetSchema,
  isValidI128String,
  SUPPORTED_CURRENCIES,
  priceSchema,
  currencySchema,
  sourceSchema,
  memoIdSchema,
} from "../src/middleware/validationSchemas";

/**
 * Test suite for request payload sanitization middleware.
 * Validates that Joi schemas correctly enforce data constraints.
 */

function testI128Validation() {
  console.log("\n🧪 Testing i128 string validation...");

  // Valid i128 strings
  const validPrices = [
    "123",
    "123.45",
    "0",
    "1e5",
    "1.23e5",
    "170141183460469231731687303715884105727", // MAX_I128
    "-170141183460469231731687303715884105728", // MIN_I128
  ];

  validPrices.forEach((price) => {
    assert.equal(
      isValidI128String(price),
      true,
      `Should accept valid i128 string: ${price}`,
    );
  });

  // Invalid i128 strings
  const invalidPrices = [
    "",
    "abc",
    "12.34.56",
    "12e34e5",
    "170141183460469231731687303715884105728", // Exceeds MAX_I128
  ];

  invalidPrices.forEach((price) => {
    assert.equal(
      isValidI128String(price),
      false,
      `Should reject invalid i128 string: ${price}`,
    );
  });

  console.log("✅ i128 validation tests passed");
}

function testPriceSchema() {
  console.log("\n🧪 Testing price schema validation...");

  // Valid prices
  const validData = [100, 123.45, "456.78", "1e5"];

  validData.forEach((price) => {
    const { isValid, error } = validateSchema(priceSchema, price);
    assert.equal(isValid, true, `Should accept valid price: ${price}`);
  });

  // Invalid prices
  const invalidData = [
    -100, // negative
    0, // zero
    "abc", // non-numeric
    null,
    undefined,
  ];

  invalidData.forEach((price) => {
    const { isValid, error } = validateSchema(priceSchema, price);
    assert.equal(isValid, false, `Should reject invalid price: ${price}`);
  });

  console.log("✅ Price schema tests passed");
}

function testCurrencySchema() {
  console.log("\n🧪 Testing currency schema validation...");

  // Valid currencies
  const validCurrencies = ["NGN", "GHS", "KES", "ZAR", "XLM", "ngn", "ghs"]; // Should uppercase

  validCurrencies.forEach((currency) => {
    const { isValid, value, error } = validateSchema(currencySchema, currency);
    assert.equal(
      isValid,
      true,
      `Should accept valid currency: ${currency} (error: ${error})`,
    );
    // Check that it's been uppercased
    if (isValid && value) {
      assert.equal(
        value,
        currency.toUpperCase(),
        `Currency should be uppercased: ${currency} -> ${value}`,
      );
    }
  });

  // Invalid currencies
  const invalidCurrencies = [
    "INVALID", // 7 letters
    "XY", // 2 letters
    "12A", // contains numbers
    "AB1", // contains numbers
    "", // empty
    null,
    undefined,
  ];

  invalidCurrencies.forEach((currency) => {
    const { isValid, error } = validateSchema(currencySchema, currency);
    assert.equal(isValid, false, `Should reject invalid currency: ${currency}`);
  });

  console.log("✅ Currency schema tests passed");
}

function testSourceSchema() {
  console.log("\n🧪 Testing source schema validation...");

  // Valid sources
  const validSources = ["CoinGecko", "ExchangeAPI", "source123", "src_api"];

  validSources.forEach((source) => {
    const { isValid, error } = validateSchema(sourceSchema, source);
    assert.equal(isValid, true, `Should accept valid source: ${source}`);
  });

  // Invalid sources
  const invalidSources = [
    "source@email", // contains special char
    "abc-def", // contains dash (not alphanumeric)
    "a b c", // contains space
    "", // empty
  ];

  invalidSources.forEach((source) => {
    const { isValid, error } = validateSchema(sourceSchema, source);
    assert.equal(isValid, false, `Should reject invalid source: ${source}`);
  });

  console.log("✅ Source schema tests passed");
}

function testMemoIdSchema() {
  console.log("\n🧪 Testing memo ID schema validation...");

  // Valid memo IDs
  const validMemoIds = [
    "SF-NGN-1234567890-001",
    "SF-GHS-1234567890-999",
    "SF-KES-0000000000-000",
  ];

  validMemoIds.forEach((memoId) => {
    const { isValid, error } = validateSchema(memoIdSchema, memoId);
    assert.equal(isValid, true, `Should accept valid memo ID: ${memoId}`);
  });

  // Invalid or missing memo IDs
  const invalidMemoIds = [
    "invalid-format",
    "SF-NGN-123-001", // too few digits
    "SF-ngn-1234567890-001", // lowercase currency
    "SF-NGNN-1234567890-001", // 4-letter currency
    "", // empty (should be optional though)
  ];

  invalidMemoIds.forEach((memoId) => {
    const { isValid, error } = validateSchema(memoIdSchema, memoId);
    // Empty string should be allowed since memoId is optional
    if (memoId === "") {
      assert.equal(isValid, true, `Memo ID should be optional`);
    } else {
      assert.equal(isValid, false, `Should reject invalid memo ID: ${memoId}`);
    }
  });

  console.log("✅ Memo ID schema tests passed");
}

function testPriceUpdateMultiSigRequestSchema() {
  console.log("\n🧪 Testing multi-sig request schema validation...");

  // Valid multi-sig request
  const validRequest = {
    priceReviewId: 123,
    currency: "NGN",
    rate: 500.5,
    source: "CoinGecko",
    memoId: "SF-NGN-1234567890-001",
  };

  const { isValid, error } = validateSchema(
    priceUpdateMultiSigRequestSchema,
    validRequest,
  );
  assert.equal(isValid, true, `Should accept valid multi-sig request`);

  // Missing required field
  const invalidRequest1 = {
    currency: "NGN",
    rate: 500.5,
    source: "CoinGecko",
    memoId: "SF-NGN-1234567890-001",
  };

  const { isValid: isValid1 } = validateSchema(
    priceUpdateMultiSigRequestSchema,
    invalidRequest1,
  );
  assert.equal(isValid1, false, `Should reject missing priceReviewId`);

  // Invalid rate
  const invalidRequest2 = {
    priceReviewId: 123,
    currency: "NGN",
    rate: -500.5, // negative
    source: "CoinGecko",
    memoId: "SF-NGN-1234567890-001",
  };

  const { isValid: isValid2 } = validateSchema(
    priceUpdateMultiSigRequestSchema,
    invalidRequest2,
  );
  assert.equal(isValid2, false, `Should reject negative rate`);

  // Unknown fields should be rejected
  const invalidRequest3 = {
    priceReviewId: 123,
    currency: "NGN",
    rate: 500.5,
    source: "CoinGecko",
    memoId: "SF-NGN-1234567890-001",
    unknownField: "should-not-be-here",
  };

  const { isValid: isValid3 } = validateSchema(
    priceUpdateMultiSigRequestSchema,
    invalidRequest3,
  );
  assert.equal(
    isValid3,
    false,
    `Should reject requests with unknown fields`,
  );

  console.log("✅ Multi-sig request schema tests passed");
}

function testSignatureRequestSchema() {
  console.log("\n🧪 Testing signature request schema validation...");

  // Valid signature request
  const validRequest = {
    multiSigPriceId: 456,
  };

  const { isValid, error } = validateSchema(
    signatureRequestSchema,
    validRequest,
  );
  assert.equal(isValid, true, `Should accept valid signature request`);

  // Missing required field
  const invalidRequest = {
    someOtherField: 123,
  };

  const { isValid: isValid2 } = validateSchema(
    signatureRequestSchema,
    invalidRequest,
  );
  assert.equal(
    isValid2,
    false,
    `Should reject missing multiSigPriceId`,
  );

  console.log("✅ Signature request schema tests passed");
}

function testMarketRateQuerySchema() {
  console.log("\n🧪 Testing market rate query schema validation...");

  // Valid query
  const validQuery = {
    currency: "NGN",
  };

  const { isValid, error } = validateSchema(marketRateQuerySchema, validQuery);
  assert.equal(isValid, true, `Should accept valid market rate query`);

  // Invalid currency
  const invalidQuery = {
    currency: "INVALID",
  };

  const { isValid: isValid2 } = validateSchema(
    marketRateQuerySchema,
    invalidQuery,
  );
  assert.equal(isValid2, false, `Should reject unsupported currency`);

  console.log("✅ Market rate query schema tests passed");
}

function testInjectionPrevention() {
  console.log("\n🧪 Testing injection attack prevention...");

  // SQL injection attempt
  const sqlInjection = {
    priceReviewId: 123,
    currency: "NGN'; DROP TABLE prices; --",
    rate: 500,
    source: "test",
  };

  const { isValid: isValid1 } = validateSchema(
    priceUpdateMultiSigRequestSchema,
    sqlInjection,
  );
  assert.equal(
    isValid1,
    false,
    `Should prevent SQL injection via currency field`,
  );

  // Script injection attempt
  const scriptInjection = {
    priceReviewId: 123,
    currency: "NGN",
    rate: 500,
    source: "<script>alert('xss')</script>",
  };

  const { isValid: isValid2 } = validateSchema(
    priceUpdateMultiSigRequestSchema,
    scriptInjection,
  );
  assert.equal(
    isValid2,
    false,
    `Should prevent script injection via source field`,
  );

  // Proto pollution attempt
  const protoPollution = {
    __proto__: { admin: true },
    priceReviewId: 123,
    currency: "NGN",
    rate: 500,
    source: "test",
  };

  const { isValid: isValid3 } = validateSchema(
    priceUpdateMultiSigRequestSchema,
    protoPollution,
  );
  assert.equal(
    isValid3,
    false,
    `Should reject __proto__ pollution attempts`,
  );

  console.log("✅ Injection prevention tests passed");
}

function runAllTests() {
  console.log(
    "🚀 Starting sanitization middleware validation tests...\n",
  );

  testI128Validation();
  testPriceSchema();
  testCurrencySchema();
  testSourceSchema();
  testMemoIdSchema();
  testPriceUpdateMultiSigRequestSchema();
  testSignatureRequestSchema();
  testMarketRateQuerySchema();
  testInjectionPrevention();

  console.log(
    "\n✅ All sanitization tests passed! Payload sanitization is working correctly.",
  );
}

runAllTests();
