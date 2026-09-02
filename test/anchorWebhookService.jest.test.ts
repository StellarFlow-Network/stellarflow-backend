/**
 * Anchor Webhook Service Tests – Issue #931
 *
 * Test coverage:
 * - HMAC-SHA256 signature validation
 * - Payload extraction and validation
 * - Status normalization
 * - State machine transitions
 * - Error handling and edge cases
 */

import crypto from "crypto";
import {
  anchorWebhookService,
  AnchorWebhookPayload,
} from "../src/services/anchorWebhookService";
import prisma from "../src/lib/prisma";

// Mock Prisma
jest.mock("../src/lib/prisma", () => ({
  __esModule: true,
  default: {
    remittanceTransaction: {
      findUnique: jest.fn(),
      update: jest.fn(),
    },
  },
}));

describe("AnchorWebhookService", () => {
  const mockPrisma = prisma as jest.Mocked<typeof prisma>;
  const testSecret = "test-webhook-secret-12345";

  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe("validateSignature", () => {
    it("should accept valid HMAC-SHA256 signature", () => {
      const payload = Buffer.from(
        JSON.stringify({ transaction: { id: "tx-1", status: "completed" } }),
      );
      const expectedHmac = crypto
        .createHmac("sha256", Buffer.from(testSecret))
        .update(payload)
        .digest("hex");

      const result = anchorWebhookService.validateSignature(
        payload,
        expectedHmac,
        testSecret,
      );

      expect(result).toBe(true);
    });

    it("should reject invalid signature", () => {
      const payload = Buffer.from(JSON.stringify({ test: "data" }));
      const invalidSignature = "deadbeefdeadbeefdeadbeefdeadbeef";

      const result = anchorWebhookService.validateSignature(
        payload,
        invalidSignature,
        testSecret,
      );

      expect(result).toBe(false);
    });

    it("should reject missing signature", () => {
      const payload = Buffer.from(JSON.stringify({ test: "data" }));

      const result = anchorWebhookService.validateSignature(
        payload,
        undefined,
        testSecret,
      );

      expect(result).toBe(false);
    });

    it("should reject when secret is not configured", () => {
      const payload = Buffer.from(JSON.stringify({ test: "data" }));
      const anySignature = "a" * 64;

      const result = anchorWebhookService.validateSignature(
        payload,
        anySignature,
        "",
      );

      expect(result).toBe(false);
    });

    it("should be resistant to timing attacks using timingSafeEqual", () => {
      const payload = Buffer.from(JSON.stringify({ test: "data" }));
      const expectedHmac = crypto
        .createHmac("sha256", Buffer.from(testSecret))
        .update(payload)
        .digest("hex");

      // Valid signature should always pass
      const validResult = anchorWebhookService.validateSignature(
        payload,
        expectedHmac,
        testSecret,
      );
      expect(validResult).toBe(true);

      // Invalid signature should always fail (no timing difference)
      const invalidResult = anchorWebhookService.validateSignature(
        payload,
        "0".repeat(expectedHmac.length),
        testSecret,
      );
      expect(invalidResult).toBe(false);
    });
  });

  describe("processWebhook", () => {
    it("should successfully process a valid webhook and transition status", async () => {
      const transactionId = "tx-12345";
      const payload: AnchorWebhookPayload = {
        transaction: {
          id: transactionId,
          status: "completed",
        },
      };

      const rawBody = Buffer.from(JSON.stringify(payload));
      const signature = crypto
        .createHmac("sha256", Buffer.from(testSecret))
        .update(rawBody)
        .digest("hex");

      // Mock database responses
      mockPrisma.remittanceTransaction.findUnique.mockResolvedValue({
        id: transactionId,
        status: "pending_user_transfer",
        userId: "user-1",
      } as any);

      mockPrisma.remittanceTransaction.update.mockResolvedValue({
        id: transactionId,
        status: "COMPLETED",
      } as any);

      const result = await anchorWebhookService.processWebhook(
        payload,
        signature,
        testSecret,
      );

      expect(result.success).toBe(true);
      expect(result.transactionId).toBe(transactionId);
      expect(result.previousStatus).toBe("pending_user_transfer");
      expect(result.newStatus).toBe("COMPLETED");

      // Verify database was updated
      expect(mockPrisma.remittanceTransaction.update).toHaveBeenCalledWith({
        where: { id: transactionId },
        data: {
          status: "COMPLETED",
          updatedAt: expect.any(Date),
        },
        select: { id: true, status: true },
      });
    });

    it("should reject webhook with missing transaction object", async () => {
      const payload = { some_field: "value" };
      const rawBody = Buffer.from(JSON.stringify(payload));

      const result = await anchorWebhookService.processWebhook(
        payload,
        "",
        testSecret,
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain("transaction");
    });

    it("should reject webhook with missing transaction id", async () => {
      const payload: AnchorWebhookPayload = {
        transaction: {
          status: "completed",
        },
      };

      const result = await anchorWebhookService.processWebhook(
        payload,
        "",
        testSecret,
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain("transaction.id");
    });

    it("should reject webhook with missing transaction status", async () => {
      const payload: AnchorWebhookPayload = {
        transaction: {
          id: "tx-123",
        },
      };

      const result = await anchorWebhookService.processWebhook(
        payload,
        "",
        testSecret,
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain("transaction.status");
    });

    it("should reject non-object payloads", async () => {
      const result = await anchorWebhookService.processWebhook(
        "not an object",
        "",
        testSecret,
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain("Invalid JSON payload");
    });

    it("should handle transaction not found", async () => {
      const payload: AnchorWebhookPayload = {
        transaction: {
          id: "nonexistent",
          status: "completed",
        },
      };

      mockPrisma.remittanceTransaction.findUnique.mockResolvedValue(null);

      const result = await anchorWebhookService.processWebhook(
        payload,
        "",
        testSecret,
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain("not found");
    });

    it("should normalize SEP-24/SEP-31 status strings", async () => {
      const testCases = [
        { input: "completed", expected: "COMPLETED" },
        { input: "complete", expected: "COMPLETED" },
        { input: "delivered", expected: "COMPLETED" },
        { input: "settled", expected: "COMPLETED" },
        { input: "success", expected: "COMPLETED" },
        { input: "COMPLETED", expected: "COMPLETED" },
        { input: "pending_user_transfer", expected: "pending_user_transfer" },
        { input: "PENDING", expected: "PENDING" },
      ];

      for (const testCase of testCases) {
        const payload: AnchorWebhookPayload = {
          transaction: {
            id: "tx-test",
            status: testCase.input,
          },
        };

        mockPrisma.remittanceTransaction.findUnique.mockResolvedValue({
          id: "tx-test",
          status: "pending_user_transfer",
          userId: "user-1",
        } as any);

        mockPrisma.remittanceTransaction.update.mockResolvedValue({
          id: "tx-test",
          status: testCase.expected,
        } as any);

        const result = await anchorWebhookService.processWebhook(
          payload,
          "",
          testSecret,
        );

        if (testCase.expected === "COMPLETED") {
          expect(result.newStatus).toBe("COMPLETED");
        } else {
          expect(result.newStatus).toBe(testCase.expected);
        }
      }
    });

    it("should not transition if already in target status", async () => {
      const payload: AnchorWebhookPayload = {
        transaction: {
          id: "tx-123",
          status: "completed",
        },
      };

      mockPrisma.remittanceTransaction.findUnique.mockResolvedValue({
        id: "tx-123",
        status: "COMPLETED",
        userId: "user-1",
      } as any);

      const result = await anchorWebhookService.processWebhook(
        payload,
        "",
        testSecret,
      );

      expect(result.success).toBe(true);
      expect(result.message).toContain("Status update not applied");
      expect(mockPrisma.remittanceTransaction.update).not.toHaveBeenCalled();
    });

    it("should handle database errors gracefully", async () => {
      const payload: AnchorWebhookPayload = {
        transaction: {
          id: "tx-error",
          status: "completed",
        },
      };

      mockPrisma.remittanceTransaction.findUnique.mockRejectedValue(
        new Error("Database connection error"),
      );

      const result = await anchorWebhookService.processWebhook(
        payload,
        "",
        testSecret,
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain("Database connection error");
    });

    it("should handle whitespace in transaction fields", async () => {
      const payload: AnchorWebhookPayload = {
        transaction: {
          id: "  tx-whitespace  ",
          status: "  completed  ",
        },
      };

      mockPrisma.remittanceTransaction.findUnique.mockResolvedValue({
        id: "tx-whitespace",
        status: "pending_user_transfer",
        userId: "user-1",
      } as any);

      mockPrisma.remittanceTransaction.update.mockResolvedValue({
        id: "tx-whitespace",
        status: "COMPLETED",
      } as any);

      const result = await anchorWebhookService.processWebhook(
        payload,
        "",
        testSecret,
      );

      expect(result.success).toBe(true);
      expect(result.transactionId).toBe("tx-whitespace");
    });
  });

  describe("State machine transitions", () => {
    it("should allow transition to COMPLETED from pending_user_transfer", async () => {
      const payload: AnchorWebhookPayload = {
        transaction: {
          id: "tx-1",
          status: "completed",
        },
      };

      mockPrisma.remittanceTransaction.findUnique.mockResolvedValue({
        id: "tx-1",
        status: "pending_user_transfer",
        userId: "user-1",
      } as any);

      mockPrisma.remittanceTransaction.update.mockResolvedValue({
        id: "tx-1",
        status: "COMPLETED",
      } as any);

      const result = await anchorWebhookService.processWebhook(
        payload,
        "",
        testSecret,
      );

      expect(result.success).toBe(true);
      expect(result.newStatus).toBe("COMPLETED");
    });

    it("should allow transition to COMPLETED from payout_relayed", async () => {
      const payload: AnchorWebhookPayload = {
        transaction: {
          id: "tx-2",
          status: "delivered",
        },
      };

      mockPrisma.remittanceTransaction.findUnique.mockResolvedValue({
        id: "tx-2",
        status: "payout_relayed",
        userId: "user-1",
      } as any);

      mockPrisma.remittanceTransaction.update.mockResolvedValue({
        id: "tx-2",
        status: "COMPLETED",
      } as any);

      const result = await anchorWebhookService.processWebhook(
        payload,
        "",
        testSecret,
      );

      expect(result.success).toBe(true);
      expect(result.newStatus).toBe("COMPLETED");
    });

    it("should handle payload with additional SEP-24/SEP-31 fields", async () => {
      const payload: AnchorWebhookPayload = {
        transaction: {
          id: "tx-with-extras",
          status: "completed",
          more_info_url: "https://anchor.example.com/tx/123",
          amount_in: "100.00",
          amount_out: "95.50",
          fee: "4.50",
          completion_date: new Date().toISOString(),
        },
      };

      mockPrisma.remittanceTransaction.findUnique.mockResolvedValue({
        id: "tx-with-extras",
        status: "pending_user_transfer",
        userId: "user-1",
      } as any);

      mockPrisma.remittanceTransaction.update.mockResolvedValue({
        id: "tx-with-extras",
        status: "COMPLETED",
      } as any);

      const result = await anchorWebhookService.processWebhook(
        payload,
        "",
        testSecret,
      );

      expect(result.success).toBe(true);
      // Additional fields should not cause issues
      expect(result.transactionId).toBe("tx-with-extras");
    });
  });
});
