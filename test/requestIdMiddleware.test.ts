import { requestIdMiddleware } from "../src/middleware/requestIdMiddleware";
import { Request, Response } from "express";

function assert(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(message);
  }
}

async function run(): Promise<void> {
  const req = {
    headers: {},
    method: "GET",
    url: "/test",
    path: "/test",
  } as Request;

  const headers: Record<string, any> = {};
  const res = {
    locals: {},
    setHeader(key: string, value: string) {
      headers[key] = value;
    },
    getHeader(key: string) {
      return headers[key];
    },
  } as unknown as Response;

  let nextCalled = false;
  const next = () => {
    nextCalled = true;
  };

  requestIdMiddleware(req, res, next);

  assert(nextCalled, "Next should be called after middleware execution");
  assert(typeof req.requestId === "string", "Request should have a requestId");
  assert(
    req.requestId?.length === 26,
    "Request ID should be 26 characters long",
  );
  assert(
    /^\d[A-Z0-9]{25}$/.test(req.requestId || "") ||
      /^[0-9A-Z]{26}$/.test(req.requestId || ""),
    "Request ID should be valid Crockford base32",
  );
  assert(
    res.getHeader("X-Request-Id") === req.requestId,
    "X-Request-Id response header should match requestId",
  );
  assert(
    (res.locals as any).requestId === req.requestId,
    "Response locals should store the requestId",
  );

  console.log("✅ Request ID middleware test passed");
}

run().catch((error) => {
  console.error("❌ Test failed:", error.message);
  process.exit(1);
});
