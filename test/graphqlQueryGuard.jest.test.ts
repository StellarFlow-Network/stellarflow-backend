/**
 * Tests for GraphQL Query Guard Middleware  (Issue #924)
 *
 * Covers:
 *  – Depth limiting (queries deeper than maxDepth are rejected)
 *  – Complexity limiting (queries exceeding maxComplexity are rejected)
 *  – Valid queries pass through untouched
 *  – Non-GraphQL POST bodies pass through
 *  – Non-POST methods pass through
 *  – Malformed query strings are rejected with a parse error
 *  – Environment variable overrides
 *  – Reason strings are descriptive
 */

import { analyzeQuery } from "../src/lib/graphqlAnalyzer";
import { graphqlQueryGuard } from "../src/middleware/graphqlQueryGuard";
import type { Request, Response } from "express";

// ─── Helper: build a minimal Express-like req/res/next ───────────────

interface MockResponse {
  statusCode: number;
  sent: Array<{ statusCode: number; data: unknown }>;
  status(code: number): MockResponse;
  json(data: unknown): MockResponse;
}

interface Harness {
  req: Request;
  res: MockResponse;
  /** Number of times next() was called */
  nextCalls: number;
  /** Call the next function */
  next: () => void;
}

function fakeReqRes(
  body?: Record<string, unknown> | null,
  method = "POST",
): Harness {
  const sent: Array<{ statusCode: number; data: unknown }> = [];
  let statusCode = 200;

  const req = {
    method,
    body: body === undefined ? {} : body,
    ip: "127.0.0.1",
    path: "/graphql",
    headers: { "content-type": "application/json" },
    queryDepth: undefined as number | undefined,
    queryComplexity: undefined as number | undefined,
  } as unknown as Request;

  const res: MockResponse = {
    statusCode,
    sent,
    status(code: number) {
      statusCode = code;
      this.statusCode = code;
      return this;
    },
    json(data: unknown) {
      sent.push({ statusCode, data });
      return this;
    },
  };

  let nextCalls = 0;
  const next = () => {
    nextCalls++;
  };

  return {
    req,
    res,
    get nextCalls() {
      return nextCalls;
    },
    next,
  };
}

// ─── analyzeQuery unit tests ─────────────────────────────────────────

describe("analyzeQuery", () => {
  it("allows a simple one-level query", () => {
    const result = analyzeQuery("{ status }");
    expect(result.allowed).toBe(true);
    expect(result.depth).toBe(1);
    expect(result.complexity).toBeGreaterThanOrEqual(1);
  });

  it("allows a query within default depth limit", () => {
    const query = `{
      user {
        name
        email
      }
    }`;
    const result = analyzeQuery(query);
    expect(result.allowed).toBe(true);
    expect(result.depth).toBe(2);
  });

  it("rejects a query exceeding max depth", () => {
    // 6 levels deep – exceeds default maxDepth of 5
    const query = `{
      a {
        b {
          c {
            d {
              e {
                f
              }
            }
          }
        }
      }
    }`;
    const result = analyzeQuery(query);
    expect(result.allowed).toBe(false);
    expect(result.depth).toBe(6);
    expect(result.reason).toContain("QUERY_TOO_DEEP");
  });

  it("rejects a query exactly at maxDepth + 1", () => {
    const query = `{ a { b { c { d { e { f } } } } } }`;
    const result = analyzeQuery(query, { maxDepth: 5 });
    expect(result.allowed).toBe(false);
    expect(result.depth).toBe(6);
  });

  it("allows a query exactly at maxDepth", () => {
    const query = `{ a { b { c { d { e } } } } }`;
    const result = analyzeQuery(query, { maxDepth: 5 });
    expect(result.allowed).toBe(true);
    expect(result.depth).toBe(5);
  });

  it("rejects a query with high complexity from many fields", () => {
    const fields = Array.from({ length: 50 }, (_, i) => `field${i}`).join(" ");
    const query = `{ ${fields} }`;
    const result = analyzeQuery(query, { maxComplexity: 10 });
    expect(result.allowed).toBe(false);
    expect(result.complexity).toBeGreaterThan(10);
    expect(result.reason).toContain("QUERY_TOO_COMPLEX");
  });

  it("rejects queries with heavy argument usage", () => {
    const query = `{
      search(a: "x", b: "y", c: "z", d: "w", e: "v", f: "u", g: "t", h: "s")
    }`;
    const result = analyzeQuery(query, { maxComplexity: 5 });
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("QUERY_TOO_COMPLEX");
  });

  it("returns a parse error for malformed GraphQL", () => {
    const result = analyzeQuery("{ unclosed {");
    expect(result.allowed).toBe(false);
    expect(result.depth).toBe(0);
    expect(result.complexity).toBe(0);
    expect(result.reason).toContain("QUERY_PARSE_ERROR");
  });

  it("treats inline fragments as depth-neutral", () => {
    const query = `{
      node {
        ... on User {
          name
        }
      }
    }`;
    const result = analyzeQuery(query);
    expect(result.allowed).toBe(true);
    expect(result.depth).toBe(2);
  });

  it("handles queries with aliases", () => {
    const query = `{
      short: user(id: 1) { name }
      long: user(id: 2) { name }
    }`;
    const result = analyzeQuery(query, { maxComplexity: 100 });
    expect(result.allowed).toBe(true);
    // Aliases add cost
    expect(result.complexity).toBeGreaterThan(4);
  });

  it("handles mutations and subscriptions (multi-operation docs)", () => {
    const query = `mutation { createOrder(amount: 10) { id status } }`;
    const result = analyzeQuery(query, { maxDepth: 5 });
    expect(result.allowed).toBe(true);
    expect(result.depth).toBe(2);
  });
});

// ─── graphqlQueryGuard middleware tests ───────────────────────────────

describe("graphqlQueryGuard middleware", () => {
  it("calls next() for GET requests", () => {
    const h = fakeReqRes(undefined, "GET");
    graphqlQueryGuard()(h.req, h.res as unknown as Response, h.next);
    expect(h.nextCalls).toBe(1);
  });

  it("calls next() for POST without a query string body", () => {
    const h = fakeReqRes({ data: "not a graphql query" });
    graphqlQueryGuard()(h.req, h.res as unknown as Response, h.next);
    expect(h.nextCalls).toBe(1);
  });

  it("calls next() for POST with empty body", () => {
    const h = fakeReqRes({});
    graphqlQueryGuard()(h.req, h.res as unknown as Response, h.next);
    expect(h.nextCalls).toBe(1);
  });

  it("passes a valid query through and attaches metrics", () => {
    const h = fakeReqRes({ query: "{ status }" });
    graphqlQueryGuard()(h.req, h.res as unknown as Response, h.next);
    expect(h.nextCalls).toBe(1);
    expect((h.req as any).queryDepth).toBeGreaterThanOrEqual(1);
    expect((h.req as any).queryComplexity).toBeGreaterThanOrEqual(1);
  });

  it("rejects a query exceeding depth and returns 400 + error array", () => {
    const h = fakeReqRes({
      query: `{ a { b { c { d { e { f } } } } } }`,
    });
    graphqlQueryGuard()(h.req, h.res as unknown as Response, h.next);
    expect(h.nextCalls).toBe(0);
    expect(h.res.sent.length).toBeGreaterThanOrEqual(1);
    const last = h.res.sent[h.res.sent.length - 1];
    expect(last.statusCode).toBe(400);
    const body = last.data as any;
    expect(body.errors).toBeDefined();
    expect(body.errors[0].message).toContain("QUERY_TOO_DEEP");
    expect(body.errors[0].extensions.code).toBe("QUERY_COMPLEXITY_EXCEEDED");
  });

  it("respects custom overrides passed to the factory", () => {
    const h = fakeReqRes({ query: "{ status }" });
    graphqlQueryGuard({ maxDepth: 1, maxComplexity: 1 })(
      h.req,
      h.res as unknown as Response,
      h.next,
    );
    // { status } has depth 1 and complexity 1 – both at limit, so should pass
    expect(h.nextCalls).toBe(1);
  });

  it("rejects when overrides are very strict", () => {
    const h = fakeReqRes({ query: "{ status }" });
    graphqlQueryGuard({ maxDepth: 0, maxComplexity: 0 })(
      h.req,
      h.res as unknown as Response,
      h.next,
    );
    expect(h.nextCalls).toBe(0);
  });

  it("handles null body gracefully", () => {
    const h = fakeReqRes(null);
    graphqlQueryGuard()(h.req, h.res as unknown as Response, h.next);
    expect(h.nextCalls).toBe(1);
  });

  it("returns a parse error for malformed queries", () => {
    const h = fakeReqRes({ query: "{ unclosed {" });
    graphqlQueryGuard()(h.req, h.res as unknown as Response, h.next);
    expect(h.nextCalls).toBe(0);
    expect(h.res.sent.length).toBeGreaterThanOrEqual(1);
    const last = h.res.sent[h.res.sent.length - 1];
    expect(last.statusCode).toBe(400);
    const body = last.data as any;
    expect(body.errors[0].message).toContain("QUERY_PARSE_ERROR");
  });
});
