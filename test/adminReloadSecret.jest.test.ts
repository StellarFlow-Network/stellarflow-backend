/**
 * Integration tests for POST /api/admin/reload-secret
 * Requirements: 10.4, 10.5, 10.6
 */

import assert from "node:assert";
import http from "node:http";
import { AddressInfo } from "node:net";
import { Keypair } from "@stellar/stellar-sdk";
import * as fc from "fast-check";

// Mock Prisma so apiKeyMiddleware can fall back to the global API_KEY
// without needing a real database connection.
jest.mock("../src/lib/prisma", () => ({
  __esModule: true,
  default: {
    relayer: {
      findFirst: jest.fn().mockResolvedValue(null),
    },
  },
}));

// ── helpers ──────────────────────────────────────────────────────────────────

type JsonResponse = { statusCode: number; body: any };

async function requestJson(
  port: number,
  path: string,
  options: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
  } = {},
): Promise<JsonResponse> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: "127.0.0.1",
        port,
        path,
        method: options.method ?? "GET",
        headers: options.headers,
      },
      (res) => {
        let raw = "";
        res.on("data", (chunk) => (raw += chunk));
        res.on("end", () => {
          try {
            resolve({ statusCode: res.statusCode ?? 0, body: JSON.parse(raw) });
          } catch (e) {
            reject(e);
          }
        });
      },
    );
    req.on("error", reject);
    if (options.body) req.write(options.body);
    req.end();
  });
}

// ── test suite ────────────────────────────────────────────────────────────────

describe("POST /api/admin/reload-secret", () => {
  const originalEnv = { ...process.env };

  let app: typeof import("../src/app").default;
  const ADMIN_KEY = "test-admin-key";
  const API_KEY = "test-api-key";
  const VALID_KEY_A = Keypair.random().secret();
  const VALID_KEY_B = Keypair.random().secret();

  beforeAll(async () => {
    process.env.API_KEY = API_KEY;
    process.env.ADMIN_API_KEY = ADMIN_KEY;
    process.env.REDIS_URL = "";
    process.env.ORACLE_SECRET_KEY = VALID_KEY_A;
    delete process.env.SOROBAN_ADMIN_SECRET;

    ({ default: app } = await import("../src/app"));
  });

  afterAll(() => {
    for (const key of Object.keys(process.env)) {
      if (!(key in originalEnv)) delete process.env[key];
    }
    Object.assign(process.env, originalEnv);
  });

  // ── helper to spin up a server for one test ──────────────────────────────

  async function withServer(
    fn: (port: number) => Promise<void>,
  ): Promise<void> {
    const server = app.listen(0);
    const { port } = server.address() as AddressInfo;
    try {
      await fn(port);
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve())),
      );
    }
  }

  function adminHeaders(
    extra: Record<string, string> = {},
  ): Record<string, string> {
    return {
      "content-type": "application/json",
      "x-api-key": API_KEY,
      "x-admin-key": ADMIN_KEY,
      ...extra,
    };
  }

  // ── unit-style integration tests ─────────────────────────────────────────

  it("authorized request with valid secretKey body → HTTP 200 (Requirement 5.3)", async () => {
    await withServer(async (port) => {
      const res = await requestJson(port, "/api/admin/reload-secret", {
        method: "POST",
        headers: adminHeaders(),
        body: JSON.stringify({ secretKey: VALID_KEY_B }),
      });

      assert.strictEqual(res.statusCode, 200);
      assert.strictEqual(res.body.success, true);
      assert.strictEqual(res.body.message, "Secret key reloaded successfully");
    });
  });

  it("authorized request without secretKey body → re-reads env, HTTP 200 (Requirement 5.4)", async () => {
    process.env.ORACLE_SECRET_KEY = VALID_KEY_A;

    await withServer(async (port) => {
      const res = await requestJson(port, "/api/admin/reload-secret", {
        method: "POST",
        headers: adminHeaders(),
        body: JSON.stringify({}),
      });

      assert.strictEqual(res.statusCode, 200);
      assert.strictEqual(res.body.success, true);
    });
  });

  it("unauthorized request (wrong x-admin-key) → HTTP 403 (Requirement 5.2)", async () => {
    await withServer(async (port) => {
      const res = await requestJson(port, "/api/admin/reload-secret", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": API_KEY,
          "x-admin-key": "wrong-key",
        },
        body: JSON.stringify({ secretKey: VALID_KEY_B }),
      });

      assert.strictEqual(res.statusCode, 403);
      assert.strictEqual(res.body.success, false);
    });
  });

  it("authorized request with invalid secretKey → HTTP 400 (Requirement 5.5)", async () => {
    await withServer(async (port) => {
      const res = await requestJson(port, "/api/admin/reload-secret", {
        method: "POST",
        headers: adminHeaders(),
        body: JSON.stringify({ secretKey: "NOT_A_VALID_KEY" }),
      });

      assert.strictEqual(res.statusCode, 400);
      assert.strictEqual(res.body.success, false);
      assert.ok(
        typeof res.body.error === "string" && res.body.error.length > 0,
      );
    });
  });

  it("authorized request with empty secretKey → HTTP 400 (Requirement 5.5)", async () => {
    await withServer(async (port) => {
      const res = await requestJson(port, "/api/admin/reload-secret", {
        method: "POST",
        headers: adminHeaders(),
        body: JSON.stringify({ secretKey: "" }),
      });

      assert.strictEqual(res.statusCode, 400);
      assert.strictEqual(res.body.success, false);
      assert.strictEqual(res.body.error, "Secret key must not be empty");
    });
  });

  it("response body never contains the submitted key value (Requirement 5.7, 8.2)", async () => {
    await withServer(async (port) => {
      const res = await requestJson(port, "/api/admin/reload-secret", {
        method: "POST",
        headers: adminHeaders(),
        body: JSON.stringify({ secretKey: VALID_KEY_B }),
      });

      const bodyStr = JSON.stringify(res.body);
      assert.ok(
        !bodyStr.includes(VALID_KEY_B),
        "Response body must not echo the submitted secret key",
      );
    });
  });

  // ── Property 5: Unauthorized requests are rejected ────────────────────────
  // Validates: Requirements 5.2

  it("Property 5: any request without valid ADMIN_API_KEY returns 403", async () => {
    await withServer(async (port) => {
      await fc.assert(
        fc.asyncProperty(
          fc
            .string({ minLength: 0, maxLength: 40 })
            .filter((s) => s !== ADMIN_KEY),
          async (badKey) => {
            const res = await requestJson(port, "/api/admin/reload-secret", {
              method: "POST",
              headers: {
                "content-type": "application/json",
                "x-api-key": API_KEY,
                "x-admin-key": badKey,
              },
              body: JSON.stringify({}),
            });
            return res.statusCode === 403 && res.body.success === false;
          },
        ),
        { numRuns: 20 },
      );
    });
  });

  // ── Property 6: Valid key returns 200 and key is not echoed ──────────────
  // Validates: Requirements 5.3, 5.7, 8.2

  it("Property 6: valid key in request body yields 200 { success: true } with no key in response", async () => {
    const validKeyArb = fc.constant(null).map(() => Keypair.random().secret());

    await withServer(async (port) => {
      await fc.assert(
        fc.asyncProperty(validKeyArb, async (key) => {
          const res = await requestJson(port, "/api/admin/reload-secret", {
            method: "POST",
            headers: adminHeaders(),
            body: JSON.stringify({ secretKey: key }),
          });

          const bodyStr = JSON.stringify(res.body);
          return (
            res.statusCode === 200 &&
            res.body.success === true &&
            !bodyStr.includes(key)
          );
        }),
        { numRuns: 20 },
      );
    });
  });

  // ── Property 7: Invalid key in request body returns 400 ──────────────────
  // Validates: Requirements 5.5

  it("Property 7: invalid key string in body yields 400 { success: false }", async () => {
    const invalidKeyArb = fc.oneof(
      fc.constant(""),
      fc.string({ minLength: 1, maxLength: 5 }).filter((s) => s.trim() !== ""),
      fc.string({ minLength: 10, maxLength: 60 }).filter((s) => {
        try {
          Keypair.fromSecret(s);
          return false;
        } catch {
          return true;
        }
      }),
    );

    await withServer(async (port) => {
      await fc.assert(
        fc.asyncProperty(invalidKeyArb, async (badKey) => {
          const res = await requestJson(port, "/api/admin/reload-secret", {
            method: "POST",
            headers: adminHeaders(),
            body: JSON.stringify({ secretKey: badKey }),
          });

          return res.statusCode === 400 && res.body.success === false;
        }),
        { numRuns: 20 },
      );
    });
  });
});
