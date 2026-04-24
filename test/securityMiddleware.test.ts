import assert from "node:assert/strict";
import {
  inspectHeadersMiddleware,
  createStrictModeMiddleware,
} from "../src/middleware/securityMiddleware";

function makeReq(headers = {}, query = {}) {
  return {
    headers,
    query,
    ip: "127.0.0.1",
    path: "/test",
  } as any;
}

function makeRes() {
  const out: any = {};
  out.status = (code: number) => {
    out._status = code;
    return out;
  };
  out.json = (obj: any) => {
    out._json = obj;
    return out;
  };
  return out as any;
}

function testInspectHeadersBlocks() {
  console.log("\n🧪 Testing inspectHeadersMiddleware blocks suspicious headers...");

  const req = makeReq({ "x-evil": "<script>alert(1)</script>" });
  const res = makeRes();
  let nextCalled = false;

  inspectHeadersMiddleware(req, res, () => {
    nextCalled = true;
  });

  assert.equal(nextCalled, false, "next should not be called");
  assert.equal(res._status, 400, "should return 400");
  assert.equal(res._json && res._json.success, false, "response.success false");

  console.log("✅ inspectHeadersMiddleware blocks suspicious headers");
}

function testInspectHeadersAllows() {
  console.log("\n🧪 Testing inspectHeadersMiddleware allows clean headers...");

  const req = makeReq({ "user-agent": "node-test" });
  const res = makeRes();
  let nextCalled = false;

  inspectHeadersMiddleware(req, res, () => {
    nextCalled = true;
  });

  assert.equal(nextCalled, true, "next should be called for clean headers");

  console.log("✅ inspectHeadersMiddleware allows clean headers");
}

function testStrictModeBlocksWhenEnabled() {
  console.log("\n🧪 Testing Strict Mode blocks suspicious query params when enabled...");

  const req = makeReq({ "x-strict-mode": "true" }, { symbol: "BTC; DROP TABLE" });
  const res = makeRes();
  let nextCalled = false;

  const strict = createStrictModeMiddleware();
  strict(req, res, () => {
    nextCalled = true;
  });

  assert.equal(nextCalled, false, "next should not be called when strict blocks");
  assert.equal(res._status, 400, "should return 400 when blocked");

  console.log("✅ Strict Mode blocked suspicious query params");
}

function testStrictModeAllowsWhenDisabled() {
  console.log("\n🧪 Testing Strict Mode allows when not enabled...");

  const req = makeReq({}, { symbol: "BTC; DROP TABLE" });
  const res = makeRes();
  let nextCalled = false;

  const strict = createStrictModeMiddleware({ enabled: false });
  strict(req, res, () => {
    nextCalled = true;
  });

  assert.equal(nextCalled, true, "next should be called when strict is not enabled");

  console.log("✅ Strict Mode allowed when not enabled");
}

function runAllTests() {
  testInspectHeadersBlocks();
  testInspectHeadersAllows();
  testStrictModeBlocksWhenEnabled();
  testStrictModeAllowsWhenDisabled();
  console.log("\n✅ All security middleware tests passed");
}

runAllTests();
