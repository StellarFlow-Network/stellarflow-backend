import {
  jest,
  describe,
  it,
  expect,
  beforeEach,
  afterEach,
} from "@jest/globals";
import type { Request, Response, NextFunction } from "express";

import {
  CorsOriginError,
  buildCorsOptions,
  corsErrorHandler,
  isExemptFromOriginGuard,
  isOriginAllowed,
  normalizeOrigin,
  originGuard,
  parseAllowedOrigins,
  refreshAllowedOrigins,
  resolveAllowedOrigins,
} from "../src/middleware/corsMiddleware";

type MockResponse = Response & {
  statusCode: number | null;
  body: unknown;
};

function createResponse(): MockResponse {
  const res = {
    statusCode: null,
    body: null,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(payload: unknown) {
      this.body = payload;
      return this;
    },
  };

  return res as unknown as MockResponse;
}

function createRequest(overrides: Partial<Request> = {}): Request {
  return {
    method: "GET",
    baseUrl: "/api",
    path: "/v1/market-rates/rates",
    ip: "203.0.113.10",
    headers: {},
    ...overrides,
  } as Request;
}

describe("normalizeOrigin", () => {
  it("trims, lowercases and strips trailing slashes", () => {
    expect(normalizeOrigin("  HTTPS://App.Example.COM/  ")).toBe(
      "https://app.example.com",
    );
  });

  it("preserves non-http schemes used by mobile webviews", () => {
    expect(normalizeOrigin("capacitor://localhost")).toBe(
      "capacitor://localhost",
    );
  });

  it("returns null for empty or non-string values", () => {
    expect(normalizeOrigin("   ")).toBeNull();
    expect(normalizeOrigin(undefined)).toBeNull();
    expect(normalizeOrigin(42)).toBeNull();
  });
});

describe("parseAllowedOrigins", () => {
  it("splits, normalizes and de-duplicates entries", () => {
    expect(
      parseAllowedOrigins(
        "https://a.example.com, https://A.example.com/ ,https://b.example.com",
      ),
    ).toEqual(["https://a.example.com", "https://b.example.com"]);
  });

  it("rejects the catch-all wildcard", () => {
    expect(parseAllowedOrigins("*")).toEqual([]);
    expect(parseAllowedOrigins("*,https://a.example.com")).toEqual([
      "https://a.example.com",
    ]);
  });

  it("rejects entries with more than one wildcard", () => {
    expect(parseAllowedOrigins("https://*.*.example.com")).toEqual([]);
  });

  it("returns an empty list when unset", () => {
    expect(parseAllowedOrigins(undefined)).toEqual([]);
    expect(parseAllowedOrigins("")).toEqual([]);
  });
});

describe("isOriginAllowed", () => {
  const allowlist = [
    "https://app.stellarflow.io",
    "https://*.dashboard.stellarflow.io",
    "capacitor://localhost",
  ];

  it("accepts an exact match", () => {
    expect(isOriginAllowed("https://app.stellarflow.io", allowlist)).toBe(true);
  });

  it("accepts an exact match regardless of case or trailing slash", () => {
    expect(isOriginAllowed("https://APP.stellarflow.io/", allowlist)).toBe(
      true,
    );
  });

  it("accepts a single-label wildcard match", () => {
    expect(
      isOriginAllowed("https://staging.dashboard.stellarflow.io", allowlist),
    ).toBe(true);
  });

  it("rejects nested subdomains under a wildcard", () => {
    expect(
      isOriginAllowed(
        "https://evil.staging.dashboard.stellarflow.io",
        allowlist,
      ),
    ).toBe(false);
  });

  it("rejects the wildcard's bare parent domain", () => {
    expect(isOriginAllowed("https://dashboard.stellarflow.io", allowlist)).toBe(
      false,
    );
  });

  it("rejects a suffix-matching lookalike domain", () => {
    expect(
      isOriginAllowed("https://app.stellarflow.io.evil.com", allowlist),
    ).toBe(false);
  });

  it("rejects a scheme downgrade", () => {
    expect(isOriginAllowed("http://app.stellarflow.io", allowlist)).toBe(false);
  });

  it("rejects unknown and empty origins", () => {
    expect(isOriginAllowed("https://evil.com", allowlist)).toBe(false);
    expect(isOriginAllowed(undefined, allowlist)).toBe(false);
  });

  it("denies everything when the allowlist is empty", () => {
    expect(isOriginAllowed("https://app.stellarflow.io", [])).toBe(false);
  });
});

describe("resolveAllowedOrigins", () => {
  it("prefers CORS_ALLOWED_ORIGINS", () => {
    expect(
      resolveAllowedOrigins({
        CORS_ALLOWED_ORIGINS: "https://a.example.com,https://b.example.com",
        DASHBOARD_URL: "https://legacy.example.com",
      }),
    ).toEqual(["https://a.example.com", "https://b.example.com"]);
  });

  it("falls back to the legacy DASHBOARD_URL and FRONTEND_URL vars", () => {
    expect(
      resolveAllowedOrigins({
        DASHBOARD_URL: "https://dash.example.com",
        FRONTEND_URL: "https://web.example.com",
      }),
    ).toEqual(["https://dash.example.com", "https://web.example.com"]);
  });

  it("denies all origins in production when nothing is configured", () => {
    expect(resolveAllowedOrigins({ NODE_ENV: "production" })).toEqual([]);
  });

  it("falls back to localhost outside production", () => {
    expect(resolveAllowedOrigins({ NODE_ENV: "development" })).toEqual([
      "http://localhost:3000",
    ]);
  });
});

describe("buildCorsOptions", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = {
      ...originalEnv,
      CORS_ALLOWED_ORIGINS: "https://app.stellarflow.io",
    };
    refreshAllowedOrigins();
  });

  afterEach(() => {
    process.env = originalEnv;
    refreshAllowedOrigins();
  });

  it("echoes an allowlisted origin", () => {
    const { origin } = buildCorsOptions();
    const callback = jest.fn();

    (origin as CallableFunction)("https://app.stellarflow.io", callback);

    expect(callback).toHaveBeenCalledWith(null, true);
  });

  it("raises CorsOriginError for a denied origin", () => {
    const { origin } = buildCorsOptions();
    const callback = jest.fn();

    (origin as CallableFunction)("https://evil.com", callback);

    const [error] = callback.mock.calls[0] as [unknown];
    expect(error).toBeInstanceOf(CorsOriginError);
    expect((error as CorsOriginError).origin).toBe("https://evil.com");
  });

  it("emits no allow-origin header when the request has no Origin", () => {
    const { origin } = buildCorsOptions();
    const callback = jest.fn();

    (origin as CallableFunction)(undefined, callback);

    expect(callback).toHaveBeenCalledWith(null, false);
  });

  it("enables credentials unless explicitly disabled", () => {
    expect(buildCorsOptions({}).credentials).toBe(true);
    expect(
      buildCorsOptions({
        CORS_ALLOW_CREDENTIALS: "false",
      }).credentials,
    ).toBe(false);
  });

  it("never advertises a wildcard in allowed headers", () => {
    const { allowedHeaders } = buildCorsOptions({});
    expect(allowedHeaders).not.toContain("*");
    expect(allowedHeaders).toContain("X-API-Key");
  });
});

describe("corsErrorHandler", () => {
  it("maps a denied origin to 403 CORS_DENIED", () => {
    const res = createResponse();
    const next = jest.fn();

    corsErrorHandler(
      new CorsOriginError("https://evil.com"),
      createRequest(),
      res,
      next as unknown as NextFunction,
    );

    expect(res.statusCode).toBe(403);
    expect(res.body).toMatchObject({
      success: false,
      error: { code: "CORS_DENIED" },
    });
    expect(next).not.toHaveBeenCalled();
  });

  it("forwards unrelated errors untouched", () => {
    const res = createResponse();
    const next = jest.fn();
    const error = new Error("database offline");

    corsErrorHandler(
      error,
      createRequest(),
      res,
      next as unknown as NextFunction,
    );

    expect(next).toHaveBeenCalledWith(error);
    expect(res.statusCode).toBeNull();
  });
});

describe("isExemptFromOriginGuard", () => {
  it("exempts probe and documentation paths", () => {
    expect(isExemptFromOriginGuard("/health")).toBe(true);
    expect(isExemptFromOriginGuard("/api/v1/docs")).toBe(true);
    expect(isExemptFromOriginGuard("/api/v1/docs/swagger-ui.css")).toBe(true);
  });

  it("does not exempt a path that merely shares a prefix", () => {
    expect(isExemptFromOriginGuard("/healthcheck-internal")).toBe(false);
    expect(isExemptFromOriginGuard("/api/v1/market-rates/rates")).toBe(false);
  });
});

describe("originGuard", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = {
      ...originalEnv,
      CORS_ALLOWED_ORIGINS: "https://app.stellarflow.io",
      CORS_ORIGIN_ENFORCEMENT: "enforce",
    };
    refreshAllowedOrigins();
  });

  afterEach(() => {
    process.env = originalEnv;
    refreshAllowedOrigins();
  });

  function run(req: Request) {
    const res = createResponse();
    const next = jest.fn();
    originGuard(req, res, next as unknown as NextFunction);
    return { res, next };
  }

  it("allows a request from an allowlisted origin", () => {
    const { res, next } = run(
      createRequest({ headers: { origin: "https://app.stellarflow.io" } }),
    );

    expect(next).toHaveBeenCalled();
    expect(res.statusCode).toBeNull();
  });

  it("blocks a request from a non-allowlisted origin", () => {
    const { res, next } = run(
      createRequest({ headers: { origin: "https://evil.com" } }),
    );

    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(403);
    expect(res.body).toMatchObject({ error: { code: "CORS_DENIED" } });
  });

  it("blocks a request with no Origin and no client credential", () => {
    const { res, next } = run(createRequest());

    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(403);
    expect(res.body).toMatchObject({ error: { code: "MISSING_ORIGIN" } });
  });

  it("allows an Origin-less request that presents an API key", () => {
    const { res, next } = run(
      createRequest({ headers: { "x-api-key": "sk_live_abc123" } }),
    );

    expect(next).toHaveBeenCalled();
    expect(res.statusCode).toBeNull();
  });

  it("allows an Origin-less relayer request carrying a signature", () => {
    const { res, next } = run(
      createRequest({
        method: "POST",
        headers: { "x-stellar-signature": "deadbeef" },
      }),
    );

    expect(next).toHaveBeenCalled();
    expect(res.statusCode).toBeNull();
  });

  it("ignores a blank credential header", () => {
    const { res, next } = run(
      createRequest({ headers: { "x-api-key": "  " } }),
    );

    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(403);
  });

  it("falls back to an allowlisted Referer when Origin is absent", () => {
    const { next } = run(
      createRequest({
        headers: { referer: "https://app.stellarflow.io/dashboard?tab=rates" },
      }),
    );

    expect(next).toHaveBeenCalled();
  });

  it("rejects a Referer from an unapproved host", () => {
    const { res, next } = run(
      createRequest({ headers: { referer: "https://evil.com/attack" } }),
    );

    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(403);
  });

  it("ignores a malformed Referer", () => {
    const { res } = run(createRequest({ headers: { referer: "not-a-url" } }));

    expect(res.statusCode).toBe(403);
  });

  it("lets preflight requests through to the CORS layer", () => {
    const { next } = run(
      createRequest({
        method: "OPTIONS",
        headers: { origin: "https://evil.com" },
      }),
    );

    expect(next).toHaveBeenCalled();
  });

  it("resolves exemptions against the mounted path prefix", () => {
    const { next } = run(createRequest({ baseUrl: "/api", path: "/v1/docs" }));

    expect(next).toHaveBeenCalled();
  });

  it("allows violations through in report-only mode", () => {
    process.env.CORS_ORIGIN_ENFORCEMENT = "report-only";

    const { res, next } = run(
      createRequest({ headers: { origin: "https://evil.com" } }),
    );

    expect(next).toHaveBeenCalled();
    expect(res.statusCode).toBeNull();
  });
});
