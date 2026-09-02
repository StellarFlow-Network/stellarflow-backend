/**
 * Integration coverage for the Issue #792 middleware chain.
 *
 * These exercise real HTTP responses rather than mocked req/res objects,
 * because the ordering defect this guards against is invisible to a unit test:
 * when the CORS error handler runs before the header middleware, `next(err)`
 * skips header injection and denial responses ship with no CSP and a
 * `X-Powered-By: Express` leak.
 */
import { describe, it, expect, beforeAll, afterAll } from "@jest/globals";
import express from "express";
import type { Server } from "http";
import type { AddressInfo } from "net";

import {
  originGuard,
  refreshAllowedOrigins,
} from "../src/middleware/corsMiddleware";
import { applyHttpSecurity } from "../src/middleware/httpSecurity";

const ALLOWED_ORIGIN = "https://app.stellarflow.io";
const WILDCARD_ORIGIN = "https://staging.dash.stellarflow.io";

let server: Server;
let baseUrl: string;

beforeAll(async () => {
  process.env.CORS_ALLOWED_ORIGINS = `${ALLOWED_ORIGIN},https://*.dash.stellarflow.io`;
  process.env.CORS_ORIGIN_ENFORCEMENT = "enforce";
  refreshAllowedOrigins();

  const app = express();
  applyHttpSecurity(app);
  app.use("/api", originGuard);
  app.get("/api/v1/rates", (_req, res) => {
    res.json({ success: true });
  });

  server = app.listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  const { port } = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${port}`;
});

afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
  delete process.env.CORS_ALLOWED_ORIGINS;
  delete process.env.CORS_ORIGIN_ENFORCEMENT;
  refreshAllowedOrigins();
});

function request(
  path: string,
  init: { method?: string; headers?: Record<string, string> } = {},
) {
  return fetch(`${baseUrl}${path}`, {
    method: init.method ?? "GET",
    headers: init.headers ?? {},
  });
}

/** Every response, whatever its status, must carry the header set. */
function expectSecurityHeaders(res: Response): void {
  expect(res.headers.get("content-security-policy")).toContain(
    "default-src 'none'",
  );
  expect(res.headers.get("x-frame-options")).toBe("DENY");
  expect(res.headers.get("x-content-type-options")).toBe("nosniff");
  expect(res.headers.get("x-powered-by")).toBeNull();
}

describe("allowed origins", () => {
  it("echoes the origin and allows credentials", async () => {
    const res = await request("/api/v1/rates", {
      headers: { Origin: ALLOWED_ORIGIN },
    });

    expect(res.status).toBe(200);
    expect(res.headers.get("access-control-allow-origin")).toBe(ALLOWED_ORIGIN);
    expect(res.headers.get("access-control-allow-credentials")).toBe("true");
    expectSecurityHeaders(res);
  });

  it("varies on Origin so caches cannot serve a cross-origin response", async () => {
    const res = await request("/api/v1/rates", {
      headers: { Origin: ALLOWED_ORIGIN },
    });

    expect(res.headers.get("vary")).toContain("Origin");
  });

  it("accepts a single-label wildcard subdomain", async () => {
    const res = await request("/api/v1/rates", {
      headers: { Origin: WILDCARD_ORIGIN },
    });

    expect(res.status).toBe(200);
    expect(res.headers.get("access-control-allow-origin")).toBe(
      WILDCARD_ORIGIN,
    );
  });
});

describe("denied origins", () => {
  it("returns 403 CORS_DENIED rather than a 500", async () => {
    const res = await request("/api/v1/rates", {
      headers: { Origin: "https://evil.com" },
    });

    expect(res.status).toBe(403);
    await expect(res.json()).resolves.toMatchObject({
      success: false,
      error: { code: "CORS_DENIED" },
    });
  });

  it("still injects security headers on the denial", async () => {
    const res = await request("/api/v1/rates", {
      headers: { Origin: "https://evil.com" },
    });

    expectSecurityHeaders(res);
  });

  it("emits no allow-origin header for a denied origin", async () => {
    const res = await request("/api/v1/rates", {
      headers: { Origin: "https://evil.com" },
    });

    expect(res.headers.get("access-control-allow-origin")).toBeNull();
  });

  it("rejects a nested subdomain under a wildcard entry", async () => {
    const res = await request("/api/v1/rates", {
      headers: { Origin: "https://evil.staging.dash.stellarflow.io" },
    });

    expect(res.status).toBe(403);
  });
});

describe("preflight", () => {
  it("answers an allowed preflight with 204 and the header set", async () => {
    const res = await request("/api/v1/rates", {
      method: "OPTIONS",
      headers: {
        Origin: ALLOWED_ORIGIN,
        "Access-Control-Request-Method": "POST",
      },
    });

    expect(res.status).toBe(204);
    expect(res.headers.get("access-control-allow-origin")).toBe(ALLOWED_ORIGIN);
    expectSecurityHeaders(res);
  });

  it("rejects a preflight from a denied origin", async () => {
    const res = await request("/api/v1/rates", {
      method: "OPTIONS",
      headers: {
        Origin: "https://evil.com",
        "Access-Control-Request-Method": "POST",
      },
    });

    expect(res.status).toBe(403);
    expectSecurityHeaders(res);
  });

  it("does not advertise a wildcard in the allowed headers", async () => {
    const res = await request("/api/v1/rates", {
      method: "OPTIONS",
      headers: {
        Origin: ALLOWED_ORIGIN,
        "Access-Control-Request-Method": "POST",
        "Access-Control-Request-Headers": "x-api-key",
      },
    });

    const allowed = res.headers.get("access-control-allow-headers") ?? "";
    expect(allowed).not.toBe("*");
    expect(allowed.toLowerCase()).toContain("x-api-key");
  });
});

describe("requests with no Origin header", () => {
  it("blocks a browser-like request with no Origin and no credential", async () => {
    const res = await request("/api/v1/rates");

    expect(res.status).toBe(403);
    await expect(res.json()).resolves.toMatchObject({
      error: { code: "MISSING_ORIGIN" },
    });
    expectSecurityHeaders(res);
  });

  it("allows a non-browser client presenting an API key", async () => {
    const res = await request("/api/v1/rates", {
      headers: { "X-API-Key": "test-key" },
    });

    expect(res.status).toBe(200);
    expect(res.headers.get("access-control-allow-origin")).toBeNull();
  });

  it("allows a relayer presenting a Stellar signature", async () => {
    const res = await request("/api/v1/rates", {
      headers: { "X-Stellar-Signature": "deadbeef" },
    });

    expect(res.status).toBe(200);
  });
});
