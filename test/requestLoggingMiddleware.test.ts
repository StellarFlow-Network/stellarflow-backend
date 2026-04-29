import { requestLoggingMiddleware } from "../src/middleware/requestLoggingMiddleware";
import { Request, Response } from "express";
import { logger } from "../src/utils/logger";

function assert(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(message);
  }
}

async function run(): Promise<void> {
  const req = {
    method: "GET",
    url: "/test",
    originalUrl: "/test",
    ip: "127.0.0.1",
    requestId: "TESTREQUESTID1234567890ABCDE",
  } as Request;

  let finishHandler: (() => void) | null = null;
  const res = {
    statusCode: 200,
    on(event: string, handler: () => void) {
      if (event === "finish") {
        finishHandler = handler;
      }
      return this;
    },
  } as unknown as Response;

  let nextCalled = false;
  const next = () => {
    nextCalled = true;
  };

  const logged: Array<{ message: string; meta: any }> = [];
  const originalInfo = (logger as any).info;
  (logger as any).info = (message: string, meta?: any) => {
    logged.push({ message, meta });
    return logger;
  };

  try {
    requestLoggingMiddleware(req, res, next);
    assert(
      nextCalled,
      "Next should be called after request logging middleware",
    );

    assert(
      logged.length === 1,
      "Logger should be called once before response finish",
    );
    assert(
      logged[0].message === "Incoming HTTP request",
      "First log should describe the incoming HTTP request",
    );
    assert(
      logged[0].meta?.requestId === req.requestId,
      "Incoming request log should include requestId",
    );

    assert(finishHandler, "Response finish handler should be registered");
    finishHandler?.();
    assert(
      logged.length === 2,
      "Logger should be called again when the response finishes",
    );
    assert(
      logged[1].message === "HTTP response completed",
      "Second log should describe the completed HTTP response",
    );
    assert(
      logged[1].meta?.requestId === req.requestId,
      "Response completion log should include requestId",
    );

    console.log("✅ Request logging middleware test passed");
  } finally {
    (logger as any).info = originalInfo;
  }
}

run().catch((error) => {
  console.error("❌ Test failed:", error.message);
  process.exit(1);
});
