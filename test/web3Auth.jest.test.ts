import express from "express";
import request from "supertest";
import { Keypair } from "@stellar/stellar-sdk";
import authRouter from "../src/routes/auth";
import { web3AuthGuard } from "../src/middleware/web3AuthGuard";

process.env.JWT_SECRET = "test-secret-key-1234567890-stellarflow";

jest.mock("../src/lib/prisma", () => {
  return {
    prisma: {
      relayer: {
        findFirst: jest.fn(() => Promise.resolve(null)),
        findUnique: jest.fn(() => Promise.resolve(null)),
        update: jest.fn(() => Promise.resolve({})),
      },
      userSession: {
        create: jest.fn(() => Promise.resolve({})),
        updateMany: jest.fn(() => Promise.resolve({ count: 1 })),
        findFirst: jest.fn(() => Promise.resolve(null)),
      },
      auditLog: {
        create: jest.fn(() => Promise.resolve({})),
      },
    },
  };
});

const app = express();
app.use(express.json());
app.use("/api/v1/auth", authRouter);

// Protected route testing web3AuthGuard
app.get("/api/v1/admin/protected", web3AuthGuard(["ADMIN"]), (req, res) => {
  res.json({
    success: true,
    user: req.user,
  });
});

describe("Issue #749: JWT & Web3 Signature Authentication Guard", () => {
  const testKeypair = Keypair.random();
  const publicKey = testKeypair.publicKey();

  describe("GET & POST /api/v1/auth/nonce", () => {
    it("generates a valid challenge nonce and expiration date", async () => {
      const res = await request(app)
        .get("/api/v1/auth/nonce")
        .query({ publicKey });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.nonce).toBeDefined();
      expect(res.body.data.nonce).toMatch(/^sf_nonce_/);
      expect(res.body.data.expiresAt).toBeDefined();
    });
  });

  describe("POST /api/v1/auth/verify-signature", () => {
    it("returns 400 when missing required fields", async () => {
      const res = await request(app)
        .post("/api/v1/auth/verify-signature")
        .send({ publicKey });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe("MISSING_CREDENTIALS");
    });

    it("returns 400 when public key is invalid", async () => {
      const res = await request(app)
        .post("/api/v1/auth/verify-signature")
        .send({
          publicKey: "INVALID_PUBLIC_KEY",
          signature: "00".repeat(64),
          nonce: "sf_nonce_123",
        });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe("INVALID_PUBLIC_KEY");
    });

    it("returns 401 when signature is invalid", async () => {
      // 1. Get nonce from server
      const nonceRes = await request(app)
        .get("/api/v1/auth/nonce")
        .query({ publicKey });
      const nonce = nonceRes.body.data.nonce;

      const invalidSignature = "00".repeat(64);
      const res = await request(app)
        .post("/api/v1/auth/verify-signature")
        .send({
          publicKey,
          signature: invalidSignature,
          nonce,
        });

      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe("INVALID_SIGNATURE");
    });

    it("issues JWT access token upon valid Stellar Web3 signature verification", async () => {
      // 1. Get nonce from server
      const nonceRes = await request(app)
        .get("/api/v1/auth/nonce")
        .query({ publicKey });
      const nonce = nonceRes.body.data.nonce;

      // Sign the nonce bytes with Ed25519 secret key
      const messageBuffer = Buffer.from(nonce, "utf-8");
      const signatureBytes = testKeypair.sign(messageBuffer);
      const signatureHex = Buffer.from(signatureBytes).toString("hex");

      const res = await request(app)
        .post("/api/v1/auth/verify-signature")
        .send({
          publicKey,
          signature: signatureHex,
          nonce,
        });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.token).toBeDefined();
      expect(res.body.data.accessToken).toBeDefined();
      expect(res.body.data.refreshToken).toBeDefined();
      expect(res.body.data.user.publicKey).toBe(publicKey);
    });

    it("rejects replayed nonce upon second authentication attempt", async () => {
      const nonceRes = await request(app)
        .get("/api/v1/auth/nonce")
        .query({ publicKey });
      const nonce = nonceRes.body.data.nonce;

      const messageBuffer = Buffer.from(nonce, "utf-8");
      const signatureHex = Buffer.from(testKeypair.sign(messageBuffer)).toString("hex");

      // First authentication pass (consumes nonce)
      const res1 = await request(app)
        .post("/api/v1/auth/verify-signature")
        .send({ publicKey, signature: signatureHex, nonce });

      expect(res1.status).toBe(200);

      // Second pass with same nonce (replay attack)
      const res2 = await request(app)
        .post("/api/v1/auth/verify-signature")
        .send({ publicKey, signature: signatureHex, nonce });

      expect(res2.status).toBe(401);
      expect(res2.body.error.code).toBe("INVALID_NONCE");
    });
  });

  describe("web3AuthGuard Middleware", () => {
    it("returns 401 when no auth headers are provided", async () => {
      const res = await request(app).get("/api/v1/admin/protected");
      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe("UNAUTHORIZED");
    });

    it("allows access with valid JWT Bearer token", async () => {
      const nonceRes = await request(app)
        .get("/api/v1/auth/nonce")
        .query({ publicKey });
      const nonce = nonceRes.body.data.nonce;

      const signatureHex = Buffer.from(testKeypair.sign(Buffer.from(nonce, "utf-8"))).toString("hex");

      const authRes = await request(app)
        .post("/api/v1/auth/verify-signature")
        .send({ publicKey, signature: signatureHex, nonce });

      const token = authRes.body.data.token;

      const res = await request(app)
        .get("/api/v1/admin/protected")
        .set("Authorization", `Bearer ${token}`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.user).toBeDefined();
    });

    it("allows direct Web3 header authentication", async () => {
      const nonceRes = await request(app)
        .get("/api/v1/auth/nonce")
        .query({ publicKey });
      const nonce = nonceRes.body.data.nonce;

      const signatureHex = Buffer.from(testKeypair.sign(Buffer.from(nonce, "utf-8"))).toString("hex");

      const res = await request(app)
        .get("/api/v1/admin/protected")
        .set("X-Stellar-PublicKey", publicKey)
        .set("X-Stellar-Signature", signatureHex)
        .set("X-Stellar-Nonce", nonce);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.user.publicKey).toBe(publicKey);
    });
  });
});
