import { describe, it, expect, beforeEach, afterEach } from "@jest/globals";
import type { Request, Response, NextFunction } from "express";

import {
  buildCspDirectives,
  refreshSecurityHeaders,
  securityHeaderPolicies,
  securityHeadersMiddleware,
} from "../src/middleware/securityHeadersMiddleware";

type HeaderBag = Record<string, string>;

function applyMiddleware(path: string): {
  headers: HeaderBag;
  removed: string[];
  nextCalled: boolean;
} {
  const headers: HeaderBag = {};
  const removed: string[] = [];
  let nextCalled = false;

  const req = { path, method: "GET", headers: {} } as Request;

  const res = {
    setHeader(name: string, value: string | number | readonly string[]) {
      headers[name.toLowerCase()] = String(value);
      return this;
    },
    getHeader(name: string) {
      return headers[name.toLowerCase()];
    },
    removeHeader(name: string) {
      removed.push(name.toLowerCase());
      delete headers[name.toLowerCase()];
    },
  } as unknown as Response;

  securityHeadersMiddleware(req, res, (() => {
    nextCalled = true;
  }) as unknown as NextFunction);

  return { headers, removed, nextCalled };
}

describe("securityHeadersMiddleware", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
    delete process.env.CSP_REPORT_ONLY;
    delete process.env.CSP_REPORT_URI;
    delete process.env.HSTS_MAX_AGE_SECONDS;
    delete process.env.HSTS_INCLUDE_SUBDOMAINS;
    refreshSecurityHeaders();
  });

  afterEach(() => {
    process.env = originalEnv;
    refreshSecurityHeaders();
  });

  it("injects the headers named in the acceptance criteria", () => {
    const { headers, nextCalled } = applyMiddleware(
      "/api/v1/market-rates/rates",
    );

    expect(headers["content-security-policy"]).toBeDefined();
    expect(headers["x-frame-options"]).toBe("DENY");
    expect(headers["x-content-type-options"]).toBe("nosniff");
    expect(nextCalled).toBe(true);
  });

  it("applies a deny-by-default CSP to API responses", () => {
    const { headers } = applyMiddleware("/api/v1/market-rates/rates");
    const csp = headers["content-security-policy"] ?? "";

    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("base-uri 'none'");
    expect(csp).toContain("form-action 'none'");
    expect(csp).not.toContain("unsafe-inline");
  });

  it("relaxes the CSP only for the Swagger UI path", () => {
    const docs = applyMiddleware("/api/v1/docs");
    const api = applyMiddleware("/api/v1/status");

    expect(docs.headers["content-security-policy"]).toContain(
      "script-src 'self' 'unsafe-inline'",
    );
    expect(api.headers["content-security-policy"]).not.toContain(
      "unsafe-inline",
    );
  });

  it("keeps the docs page unframeable despite the looser CSP", () => {
    const { headers } = applyMiddleware("/api/v1/docs");

    expect(headers["x-frame-options"]).toBe("DENY");
    expect(headers["content-security-policy"]).toContain(
      "frame-ancestors 'none'",
    );
  });

  it("sends the supporting header set", () => {
    const { headers, removed } = applyMiddleware("/api/v1/status");

    expect(headers["permissions-policy"]).toBe(
      securityHeaderPolicies.permissionsPolicy,
    );
    expect(headers["x-permitted-cross-domain-policies"]).toBe("none");
    expect(headers["referrer-policy"]).toBe("strict-origin-when-cross-origin");
    expect(headers["cross-origin-opener-policy"]).toBe("same-origin");
    expect(headers["cross-origin-resource-policy"]).toBe("same-origin");
    expect(headers["strict-transport-security"]).toContain("max-age=31536000");
    expect(removed).toContain("x-powered-by");
  });

  it("denies camera, geolocation and microphone via Permissions-Policy", () => {
    const { headers } = applyMiddleware("/api/v1/status");
    const policy = headers["permissions-policy"] ?? "";

    for (const feature of ["camera", "geolocation", "microphone", "usb"]) {
      expect(policy).toContain(`${feature}=()`);
    }
  });

  it("honours HSTS overrides", () => {
    process.env.HSTS_MAX_AGE_SECONDS = "600";
    process.env.HSTS_INCLUDE_SUBDOMAINS = "true";
    refreshSecurityHeaders();

    const { headers } = applyMiddleware("/api/v1/status");

    expect(headers["strict-transport-security"]).toBe(
      "max-age=600; includeSubDomains",
    );
  });

  it("switches to report-only mode when configured", () => {
    process.env.CSP_REPORT_ONLY = "true";
    refreshSecurityHeaders();

    const { headers } = applyMiddleware("/api/v1/status");

    expect(headers["content-security-policy-report-only"]).toBeDefined();
    expect(headers["content-security-policy"]).toBeUndefined();
  });
});

describe("buildCspDirectives", () => {
  it("leaves directives untouched when no report URI is set", () => {
    const base = { "default-src": ["'none'"] };
    expect(buildCspDirectives(base, {})).toEqual(base);
  });

  it("appends a report-uri when configured", () => {
    const result = buildCspDirectives(
      { "default-src": ["'none'"] },
      {
        CSP_REPORT_URI: "https://csp.example.com/report",
      },
    );

    expect(result["report-uri"]).toEqual(["https://csp.example.com/report"]);
  });

  it("does not mutate the shared policy objects", () => {
    buildCspDirectives(securityHeaderPolicies.api, {
      CSP_REPORT_URI: "https://csp.example.com/report",
    });

    expect(securityHeaderPolicies.api["report-uri"]).toBeUndefined();
  });
});
