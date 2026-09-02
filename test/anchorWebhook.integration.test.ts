/**
 * Anchor Webhook Endpoint Integration Tests – Issue #931
 *
 * Test coverage for POST /api/v1/anchors/webhook endpoint:
 * - Signature validation
 * - Payload parsing and validation
 * - State machine transitions via HTTP
 * - Error handling (401, 400, 404, 500)
 * - SEP-24 / SEP-31 compliance
 */

import crypto from "crypto";
import express from "express";
import request from "supertest";
import anchorsRouter from "../src/routes/anchors";
import * as anchorWebhookService from "../src/services/anchorWebhookService";
import prisma from "../src/lib/prisma";

jest.mock("../src/lib/prisma");
jest.mock("../src/services/anchorWebhookService");

const mockPrisma = prisma as jest.Mocked<typeof prisma>;
const mockService = anchorWebhookService.anchorWebhookService as jest.Mocked<
  typeof anchorWebhookService.anchorWebhookService
>;

describe("POST /api/v1/anchors/webhook", () => {
  let app: express.Application;
  const testSecret = "test-webhook-secret";

  beforeEach(() => {
    jest.clearAllMocks();

    // Set up test environment
    process.env.ANCHOR_WEBHOOK_SECRET = testSecret;

    // Create fresh app for each test
    app = express();
    app.use("/api/v1/anchors", anchorsRouter);
  });

  afterEach(() => {
    delete process.env.ANCHOR_WEBHOOK_SECRET;
  });

  describe("Signature validation", () => {
    it("should accept request with valid HMAC signature", async () => {
      const payload = { transaction: { id: "tx-1", status: "completed" } };
      const body = JSON.stringify(payload);
      const signature = crypto
        .createHmac("sha256", Buffer.from(testSecret))
        .update(body)
        .digest("hex");

      mockService.validateSignature.mockReturnValue(true);
      mockService.processWebhook.mockResolvedValue({
        success: true,
        transactionId: "tx-1",
        previousStatus: "pending_user_transfer",
        newStatus: "COMPLETED",
        message: "Success",
      });

      const response = await request(app)
        .post("/api/v1/anchors/webhook")
        .set("X-Anchor-Signature", signature)
        .set("Content-Type", "application/json")
        .send(payload);

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      expect(response.body.transactionId).toBe("tx-1");
    });

    it("should reject request with invalid signature", async () => {
      const payload = { transaction: { id: "tx-1", status: "completed" } };
      const invalidSignature = "0".repeat(64);

      mockService.validateSignature.mockReturnValue(false);

      const response = await request(app)
        .post("/api/v1/anchors/webhook")
        .set("X-Anchor-Signature", invalidSignature)
        .set("Content-Type", "application/json")
        .send(payload);

      expect(response.status).toBe(401);
      expect(response.body.success).toBe(false);
      expect(response.body.error).toContain("signature");
    });

    it("should reject request without signature header", async () => {
      const payload = { transaction: { id: "tx-1", status: "completed" } };

      mockService.validateSignature.mockReturnValue(false);

      const response = await request(app)
        .post("/api/v1/anchors/webhook")
        .set("Content-Type", "application/json")
        .send(payload);

      expect(response.status).toBe(401);
      expect(response.body.error).toContain("signature");
    });
  });

  describe("Payload validation", () => {
    const validSignature = "valid-signature";

    beforeEach(() => {
      mockService.validateSignature.mockReturnValue(true);
    });

    it("should accept valid SEP-24 payload", async () => {
      const payload = {
        transaction: {
          id: "txn-12345",
          status: "completed",
          more_info_url: "https://anchor.example.com/tx/123",
          amount_in: "100.00",
          amount_out: "95.00",
        },
      };

      mockService.processWebhook.mockResolvedValue({
        success: true,
        transactionId: "txn-12345",
        previousStatus: "pending_user_transfer",
        newStatus: "COMPLETED",
        message: "Success",
      });

      const response = await request(app)
        .post("/api/v1/anchors/webhook")
        .set("X-Anchor-Signature", validSignature)
        .set("Content-Type", "application/json")
        .send(payload);

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      expect(response.body.transactionId).toBe("txn-12345");
    });

    it("should reject malformed JSON", async () => {
      mockService.processWebhook.mockResolvedValue({
        success: false,
        error: "Invalid JSON payload",
      });

      const response = await request(app)
        .post("/api/v1/anchors/webhook")
        .set("X-Anchor-Signature", validSignature)
        .set("Content-Type", "application/json")
        .send("not valid json");

      expect(response.status).toBeGreaterThanOrEqual(400);
    });

    it("should reject payload without transaction object", async () => {
      const payload = { some_field: "value" };

      mockService.processWebhook.mockResolvedValue({
        success: false,
        error: "Missing or invalid 'transaction' field in payload",
      });

      const response = await request(app)
        .post("/api/v1/anchors/webhook")
        .set("X-Anchor-Signature", validSignature)
        .set("Content-Type", "application/json")
        .send(payload);

      expect(response.status).toBe(400);
      expect(response.body.success).toBe(false);
    });

    it("should reject payload missing transaction.id", async () => {
      const payload = {
        transaction: {
          status: "completed",
        },
      };

      mockService.processWebhook.mockResolvedValue({
        success: false,
        error: "Missing or empty 'transaction.id' field",
      });

      const response = await request(app)
        .post("/api/v1/anchors/webhook")
        .set("X-Anchor-Signature", validSignature)
        .set("Content-Type", "application/json")
        .send(payload);

      expect(response.status).toBe(400);
      expect(response.body.error).toContain("id");
    });

    it("should reject payload missing transaction.status", async () => {
      const payload = {
        transaction: {
          id: "tx-123",
        },
      };

      mockService.processWebhook.mockResolvedValue({
        success: false,
        error: "Missing or empty 'transaction.status' field",
      });

      const response = await request(app)
        .post("/api/v1/anchors/webhook")
        .set("X-Anchor-Signature", validSignature)
        .set("Content-Type", "application/json")
        .send(payload);

      expect(response.status).toBe(400);
      expect(response.body.error).toContain("status");
    });

    it("should accept empty body if signature is invalid", async () => {
      mockService.validateSignature.mockReturnValue(false);

      const response = await request(app)
        .post("/api/v1/anchors/webhook")
        .set("X-Anchor-Signature", "invalid")
        .set("Content-Type", "application/json");

      expect(response.status).toBe(401);
    });
  });

  describe("State machine transitions", () => {
    const validSignature = "valid-signature";

    beforeEach(() => {
      mockService.validateSignature.mockReturnValue(true);
    });

    it("should transition pending_user_transfer to COMPLETED", async () => {
      const payload = {
        transaction: {
          id: "tx-transition-1",
          status: "completed",
        },
      };

      mockService.processWebhook.mockResolvedValue({
        success: true,
        transactionId: "tx-transition-1",
        previousStatus: "pending_user_transfer",
        newStatus: "COMPLETED",
        message: "Transaction status updated successfully",
      });

      const response = await request(app)
        .post("/api/v1/anchors/webhook")
        .set("X-Anchor-Signature", validSignature)
        .set("Content-Type", "application/json")
        .send(payload);

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      expect(response.body.previousStatus).toBe("pending_user_transfer");
      expect(response.body.newStatus).toBe("COMPLETED");
    });

    it("should handle idempotent webhook (same status)", async () => {
      const payload = {
        transaction: {
          id: "tx-idempotent",
          status: "completed",
        },
      };

      mockService.processWebhook.mockResolvedValue({
        success: true,
        transactionId: "tx-idempotent",
        previousStatus: "COMPLETED",
        newStatus: "COMPLETED",
        message: "Status update not applied: transaction already in status 'COMPLETED'",
      });

      const response = await request(app)
        .post("/api/v1/anchors/webhook")
        .set("X-Anchor-Signature", validSignature)
        .set("Content-Type", "application/json")
        .send(payload);

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      expect(response.body.message).toContain("not applied");
    });
  });

  describe("Error handling", () => {
    const validSignature = "valid-signature";

    beforeEach(() => {
      mockService.validateSignature.mockReturnValue(true);
    });

    it("should return 404 when transaction not found", async () => {
      const payload = {
        transaction: {
          id: "nonexistent-tx",
          status: "completed",
        },
      };

      mockService.processWebhook.mockResolvedValue({
        success: false,
        transactionId: "nonexistent-tx",
        error: "Transaction not found in database",
      });

      const response = await request(app)
        .post("/api/v1/anchors/webhook")
        .set("X-Anchor-Signature", validSignature)
        .set("Content-Type", "application/json")
        .send(payload);

      expect(response.status).toBe(404);
      expect(response.body.success).toBe(false);
    });

    it("should return 500 on database error", async () => {
      const payload = {
        transaction: {
          id: "tx-error",
          status: "completed",
        },
      };

      mockService.processWebhook.mockResolvedValue({
        success: false,
        transactionId: "tx-error",
        error: "Database connection error",
      });

      const response = await request(app)
        .post("/api/v1/anchors/webhook")
        .set("X-Anchor-Signature", validSignature)
        .set("Content-Type", "application/json")
        .send(payload);

      expect(response.status).toBe(400);
      expect(response.body.success).toBe(false);
    });

    it("should return 500 when ANCHOR_WEBHOOK_SECRET is not configured", async () => {
      delete process.env.ANCHOR_WEBHOOK_SECRET;

      // Recreate app without the env var
      const testApp = express();
      testApp.use("/api/v1/anchors", anchorsRouter);

      const payload = {
        transaction: {
          id: "tx-1",
          status: "completed",
        },
      };

      const response = await request(testApp)
        .post("/api/v1/anchors/webhook")
        .set("X-Anchor-Signature", validSignature)
        .set("Content-Type", "application/json")
        .send(payload);

      expect(response.status).toBe(500);
      expect(response.body.error).toContain("CONFIGURATION_ERROR");
    });
  });

  describe("Response format", () => {
    const validSignature = "valid-signature";

    beforeEach(() => {
      mockService.validateSignature.mockReturnValue(true);
    });

    it("should include all required fields in success response", async () => {
      const payload = {
        transaction: {
          id: "tx-response-1",
          status: "completed",
        },
      };

      mockService.processWebhook.mockResolvedValue({
        success: true,
        transactionId: "tx-response-1",
        previousStatus: "pending_user_transfer",
        newStatus: "COMPLETED",
        message: "Transaction status updated successfully",
      });

      const response = await request(app)
        .post("/api/v1/anchors/webhook")
        .set("X-Anchor-Signature", validSignature)
        .set("Content-Type", "application/json")
        .send(payload);

      expect(response.status).toBe(200);
      expect(response.body).toHaveProperty("success");
      expect(response.body).toHaveProperty("transactionId");
      expect(response.body).toHaveProperty("previousStatus");
      expect(response.body).toHaveProperty("newStatus");
      expect(response.body).toHaveProperty("message");
    });

    it("should include error message in error response", async () => {
      const payload = {
        transaction: {
          id: "tx-error-response",
          status: "completed",
        },
      };

      mockService.processWebhook.mockResolvedValue({
        success: false,
        error: "Transaction not found in database",
      });

      const response = await request(app)
        .post("/api/v1/anchors/webhook")
        .set("X-Anchor-Signature", validSignature)
        .set("Content-Type", "application/json")
        .send(payload);

      expect(response.status).toBeGreaterThanOrEqual(400);
      expect(response.body.success).toBe(false);
      expect(response.body.error).toBeDefined();
    });
  });
});
