/**
 * Unit tests for DisputeService – Issue #834
 *
 * Covers:
 *  - Opening a dispute ticket (status `open`) + email/webhook dispatch
 *  - State-machine transition enforcement
 *  - Manual refund flow + refund metadata
 *  - get/list helpers and error paths
 */

// ---------------------------------------------------------------------------
// Mock prisma before importing the service
// ---------------------------------------------------------------------------
const mockDisputeCreate = jest.fn<() => Promise<any>>();
const mockDisputeFindMany = jest.fn<() => Promise<any[]>>();
const mockDisputeCount = jest.fn<() => Promise<number>>();
const mockDisputeFindUnique = jest.fn<() => Promise<any>>();
const mockDisputeUpdate = jest.fn<() => Promise<any>>();

jest.mock("../src/lib/prisma", () => ({
  __esModule: true,
  default: {
    remittanceDispute: {
      create: mockDisputeCreate,
      findMany: mockDisputeFindMany,
      count: mockDisputeCount,
      findUnique: mockDisputeFindUnique,
      update: mockDisputeUpdate,
    },
  },
}));

// ---------------------------------------------------------------------------
// Mock email + webhook dispatch
// ---------------------------------------------------------------------------
const mockEmailSend = jest.fn<() => Promise<boolean>>();
const mockHttpPost = jest.fn<() => Promise<{ status: number }>>();

jest.mock("../src/services/emailService", () => ({
  __esModule: true,
  emailService: { send: mockEmailSend },
}));

jest.mock("../src/lib/httpClient", () => ({
  __esModule: true,
  httpClient: { post: mockHttpPost },
}));

// ---------------------------------------------------------------------------
// Import subject under test
// ---------------------------------------------------------------------------
import { DisputeService } from "../src/services/disputeService";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function makeRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "dispute-1",
    remittanceId: "txn-1",
    userId: "user-1",
    status: "open",
    reason: "Fiat payout timed out",
    details: null,
    email: "user@example.com",
    webhookUrl: "https://hooks.example.com/dispute",
    refundAmount: null,
    refundedById: null,
    refundedAt: null,
    resolvedById: null,
    resolvedAt: null,
    createdAt: new Date("2026-08-28T00:00:00Z"),
    updatedAt: new Date("2026-08-28T00:00:00Z"),
    ...overrides,
  };
}

describe("DisputeService", () => {
  let service: DisputeService;

  beforeEach(() => {
    jest.clearAllMocks();
    service = new DisputeService();
    mockEmailSend.mockResolvedValue(true);
    mockHttpPost.mockResolvedValue({ status: 200 });
  });

  describe("openDispute", () => {
    it("creates an 'open' ticket and dispatches email + webhook notifications", async () => {
      mockDisputeCreate.mockResolvedValue(makeRow());

      const result = await service.openDispute({
        remittanceId: "txn-1",
        userId: "user-1",
        reason: "Fiat payout timed out",
        details: { payoutRef: "PF-001", attempts: 3 },
        email: "user@example.com",
        webhookUrl: "https://hooks.example.com/dispute",
      });

      expect(result.success).toBe(true);
      expect(result.dispute?.status).toBe("open");

      expect(mockDisputeCreate).toHaveBeenCalledWith({
        data: expect.objectContaining({
          remittanceId: "txn-1",
          userId: "user-1",
          status: "open",
          reason: "Fiat payout timed out",
          details: JSON.stringify({ payoutRef: "PF-001", attempts: 3 }),
          email: "user@example.com",
          webhookUrl: "https://hooks.example.com/dispute",
        }),
      });

      expect(mockEmailSend).toHaveBeenCalledWith(
        expect.objectContaining({
          to: "user@example.com",
          subject: expect.stringContaining("Dispute opened"),
        }),
      );

      expect(mockHttpPost).toHaveBeenCalledWith(
        "https://hooks.example.com/dispute",
        expect.objectContaining({ eventType: "dispute.state_changed" }),
        expect.any(Object),
      );
    });

    it("rejects when required fields are missing", async () => {
      const result = await service.openDispute({
        remittanceId: "txn-1",
        userId: "user-1",
        reason: "",
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain("required");
      expect(mockDisputeCreate).not.toHaveBeenCalled();
    });

    it("still returns success when notification dispatch throws", async () => {
      mockDisputeCreate.mockResolvedValue(makeRow());
      mockEmailSend.mockRejectedValue(new Error("SES down"));

      const result = await service.openDispute({
        remittanceId: "txn-1",
        userId: "user-1",
        reason: "Fiat payout failed",
        email: "user@example.com",
      });

      expect(result.success).toBe(true);
      expect(result.dispute?.status).toBe("open");
    });
  });

  describe("transitionStatus", () => {
    it("rejects an invalid transition (closed -> open)", async () => {
      mockDisputeFindUnique.mockResolvedValue(makeRow({ status: "closed" }));

      const result = await service.transitionStatus("dispute-1", {
        toStatus: "open",
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain("Cannot transition");
      expect(mockDisputeUpdate).not.toHaveBeenCalled();
    });

    it("applies a valid transition and dispatches notifications", async () => {
      mockDisputeFindUnique.mockResolvedValue(makeRow({ status: "open" }));
      mockDisputeUpdate.mockResolvedValue(
        makeRow({ status: "investigating" }),
      );

      const result = await service.transitionStatus("dispute-1", {
        toStatus: "investigating",
        byId: "admin-1",
      });

      expect(result.success).toBe(true);
      expect(result.dispute?.status).toBe("investigating");
      expect(mockDisputeUpdate).toHaveBeenCalledWith({
        where: { id: "dispute-1" },
        data: expect.objectContaining({ status: "investigating" }),
      });
      expect(mockEmailSend).toHaveBeenCalledWith(
        expect.objectContaining({
          subject: expect.stringContaining("under investigation"),
        }),
      );
    });

    it("returns not-found when the ticket does not exist", async () => {
      mockDisputeFindUnique.mockResolvedValue(null);

      const result = await service.transitionStatus("missing", {
        toStatus: "closed",
      });

      expect(result.success).toBe(false);
      expect(result.error).toBe("Dispute ticket not found");
    });
  });

  describe("triggerManualRefund", () => {
    it("marks the ticket refunded with metadata and dispatches notifications", async () => {
      mockDisputeFindUnique.mockResolvedValue(makeRow());
      mockDisputeUpdate.mockResolvedValue(
        makeRow({
          status: "refunded",
          refundAmount: { valueOf: () => 150.5 },
          refundedById: "admin-1",
          refundedAt: new Date(),
        }),
      );

      const result = await service.triggerManualRefund("dispute-1", {
        refundAmount: 150.5,
        byId: "admin-1",
      });

      expect(result.success).toBe(true);
      expect(result.dispute?.status).toBe("refunded");
      expect(result.dispute?.refundAmount).toBe(150.5);
      expect(result.dispute?.refundedById).toBe("admin-1");
      expect(mockDisputeUpdate).toHaveBeenCalledWith({
        where: { id: "dispute-1" },
        data: expect.objectContaining({
          status: "refunded",
          refundAmount: 150.5,
          refundedById: "admin-1",
        }),
      });
      expect(mockEmailSend).toHaveBeenCalledWith(
        expect.objectContaining({
          subject: expect.stringContaining("Refund issued"),
        }),
      );
    });

    it("rejects refunding an already closed ticket", async () => {
      mockDisputeFindUnique.mockResolvedValue(makeRow({ status: "closed" }));

      const result = await service.triggerManualRefund("dispute-1", {});

      expect(result.success).toBe(false);
      expect(result.error).toContain("already been closed");
      expect(mockDisputeUpdate).not.toHaveBeenCalled();
    });
  });

  describe("getDispute / listDisputes", () => {
    it("returns an error when the dispute is not found", async () => {
      mockDisputeFindUnique.mockResolvedValue(null);

      const result = await service.getDispute("missing");

      expect(result.success).toBe(false);
      expect(result.error).toBe("Dispute ticket not found");
    });

    it("lists disputes with filters", async () => {
      mockDisputeFindMany.mockResolvedValue([makeRow()]);
      mockDisputeCount.mockResolvedValue(1);

      const result = await service.listDisputes({ status: "open" });

      expect(result.success).toBe(true);
      expect(result.total).toBe(1);
      expect(result.data?.[0]?.status).toBe("open");
    });
  });
});