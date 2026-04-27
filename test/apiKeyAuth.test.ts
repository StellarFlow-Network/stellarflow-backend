import express, { Request, Response } from "express";
import request from "supertest";
 
// ------------------------------------------------------------------
// Mock Prisma so the tests run without a real database
// ------------------------------------------------------------------
jest.mock("@prisma/client", () => {
  const READ_ONLY_KEY_HASH =
    "5e884898da28047151d0e56f8dc6292773603d0d6aabbdd62a11ef721d1542d8"; // sha256("password") placeholder
  const READ_WRITE_KEY_HASH =
    "2de48264c8288264751242ca39088d673c6455f42907f1ccae44286a9fdd1db4";
 
  const records: Record<
    string,
    {
      id: string;
      label: string;
      scopes: string[];
      ownerId: null;
      isActive: boolean;
      expiresAt: null;
    }
  > = {
    [READ_ONLY_KEY_HASH]: {
      id: "key-read",
      label: "read-only",
      scopes: ["read"],
      ownerId: null,
      isActive: true,
      expiresAt: null,
    },
    [READ_WRITE_KEY_HASH]: {
      id: "key-write",
      label: "read-write",
      scopes: ["read", "write"],
      ownerId: null,
      isActive: true,
      expiresAt: null,
    },
  };
 
  return {
    PrismaClient: jest.fn().mockImplementation(() => ({
      apiKey: {
        findUnique: jest.fn(({ where }: { where: { key: string } }) =>
          Promise.resolve(records[where.key] ?? null)
        ),
        update: jest.fn(() => Promise.resolve({})),
      },
    })),
  };
});
 
// ------------------------------------------------------------------
// Build a minimal test app
// ------------------------------------------------------------------
import { apiKeyAuth } from "../src/middleware/apiKeyAuth.middleware";
 
const app = express();
app.use(express.json());
app.use(apiKeyAuth());
 
app.get("/api/v1/market-rate", (_req: Request, res: Response) => {
  res.json({ success: true, data: "rates" });
});
 
app.post("/api/v1/market-rate/update", (req: Request, res: Response) => {
  res.status(202).json({ success: true, accepted: req.body });
});
 
// ------------------------------------------------------------------
// Test key values (these hash to the constants above in the mock)
// ------------------------------------------------------------------
const READ_ONLY_RAW  = "password";      // hashes to READ_ONLY_KEY_HASH  (mock only)
const READ_WRITE_RAW = "readwritekey";  // hashes to READ_WRITE_KEY_HASH (mock only)
const INVALID_RAW    = "notakey";
 
// ------------------------------------------------------------------
// Tests
// ------------------------------------------------------------------
 
describe("API Key Scope Middleware", () => {
 
  // ── Missing key ────────────────────────────────────────────────
  describe("No X-API-Key header", () => {
    it("returns 401 MISSING_API_KEY on GET", async () => {
      const res = await request(app).get("/api/v1/market-rate");
      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe("MISSING_API_KEY");
    });
 
    it("returns 401 MISSING_API_KEY on POST", async () => {
      const res = await request(app)
        .post("/api/v1/market-rate/update")
        .send({ pair: "NGN/XLM", price: 0.002, source: "test" });
      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe("MISSING_API_KEY");
    });
  });
 
  // ── Invalid key ────────────────────────────────────────────────
  describe("Invalid X-API-Key header", () => {
    it("returns 401 INVALID_API_KEY", async () => {
      const res = await request(app)
        .get("/api/v1/market-rate")
        .set("X-API-Key", INVALID_RAW);
      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe("INVALID_API_KEY");
    });
  });
 
  // ── Read-only key ──────────────────────────────────────────────
  describe("Read-only key (scopes: [read])", () => {
    it("allows GET /api/v1/market-rate → 200", async () => {
      const res = await request(app)
        .get("/api/v1/market-rate")
        .set("X-API-Key", READ_ONLY_RAW);
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
    });
 
    it("blocks POST /api/v1/market-rate/update → 403 INSUFFICIENT_SCOPE", async () => {
      const res = await request(app)
        .post("/api/v1/market-rate/update")
        .set("X-API-Key", READ_ONLY_RAW)
        .send({ pair: "NGN/XLM", price: 0.002, source: "test" });
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe("INSUFFICIENT_SCOPE");
      expect(res.body.error.message).toMatch(/write/);
    });
  });
 
  // ── Read-write key ─────────────────────────────────────────────
  describe("Read-write key (scopes: [read, write])", () => {
    it("allows GET /api/v1/market-rate → 200", async () => {
      const res = await request(app)
        .get("/api/v1/market-rate")
        .set("X-API-Key", READ_WRITE_RAW);
      expect(res.status).toBe(200);
    });
 
    it("allows POST /api/v1/market-rate/update → 202", async () => {
      const res = await request(app)
        .post("/api/v1/market-rate/update")
        .set("X-API-Key", READ_WRITE_RAW)
        .send({ pair: "NGN/XLM", price: 0.002, source: "test" });
      expect(res.status).toBe(202);
      expect(res.body.success).toBe(true);
    });
  });
 
  // ── Error shape ────────────────────────────────────────────────
  describe("Error response shape", () => {
    it("always returns { success: false, error: { code, message } }", async () => {
      const res = await request(app).get("/api/v1/market-rate");
      expect(res.body).toMatchObject({
        success: false,
        error: {
          code: expect.any(String),
          message: expect.any(String),
        },
      });
    });
  });
});
 
