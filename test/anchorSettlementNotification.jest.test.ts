/**
 * Multi-Anchor Settlement Push Notification Service Unit Tests – Issue #1002
 */

import { describe, it, expect, beforeEach, jest } from "@jest/globals";
import crypto from "crypto";

// Mock Prisma
const mockPrismaFindUnique = jest.fn<() => Promise<any>>();
const mockPrismaExecuteRawUnsafe = jest.fn<() => Promise<any>>();
const mockPrismaQueryRawUnsafe = jest.fn<() => Promise<any>>();
const mockPrismaUpdate = jest.fn<() => Promise<any>>();

jest.unstable_mockModule("../src/lib/prisma", () => ({
  __esModule: true,
  default: {
    remittanceTransaction: {
      findUnique: mockPrismaFindUnique,
      updateMany: mockPrismaUpdate,
    },
    $executeRawUnsafe: mockPrismaExecuteRawUnsafe,
    $queryRawUnsafe: mockPrismaQueryRawUnsafe,
  },
}));

// Mock httpClient
const mockHttpPost = jest.fn<() => Promise<any>>();
jest.unstable_mockModule("../src/lib/httpClient", () => ({
  __esModule: true,
  httpClient: {
    post: mockHttpPost,
  },
}));

jest.unstable_mockModule("../src/utils/logger", () => ({
  createFetcherLogger: () => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  }),
}));
jest.unstable_mockModule("../src/services/sep31Service", () => ({
  dispatchSep31CompletionCallback: jest
    .fn<() => Promise<void>>()
    .mockResolvedValue(undefined),
}));
const {
  AnchorSettlementNotificationService,
  anchorSettlementNotificationService,
} = await import("../src/services/anchorSettlementNotificationService");
const { anchorWebhookService } =
  await import("../src/services/anchorWebhookService");

describe("AnchorSettlementNotificationService", () => {
  let service: InstanceType<typeof AnchorSettlementNotificationService>;

  beforeEach(() => {
    jest.clearAllMocks();
    mockPrismaExecuteRawUnsafe.mockResolvedValue(1);
    mockPrismaQueryRawUnsafe.mockResolvedValue([]);
    mockHttpPost.mockResolvedValue({ status: 200, data: { sid: "SM123" } });

    service = new AnchorSettlementNotificationService(
      "AC_test_account_sid",
      "test_auth_token",
      "+15550001111",
      "SG.test_sendgrid_key",
      "notifications@stellarflow.io",
    );
  });

  it("fails instead of reporting delivery when credentials are missing", async () => {
    const unconfigured = new AnchorSettlementNotificationService(
      "",
      "",
      "",
      "",
      "",
    );
    const payload = {
      transactionId: "tx",
      status: "COMPLETED",
      amount: 1,
      currency: "USD",
      recipient: { phone: "+1234567890", email: "a@example.com" },
    };
    expect((await unconfigured.sendTwilioSms(payload)).success).toBe(false);
    expect((await unconfigured.sendSendGridEmail(payload)).success).toBe(false);
    expect(mockHttpPost).not.toHaveBeenCalled();
  });

  it("rejects phone numbers without an international prefix", async () => {
    const result = await service.sendTwilioSms({
      transactionId: "tx",
      status: "COMPLETED",
      amount: 1,
      currency: "USD",
      recipient: { phone: "08012345678" },
    });
    expect(result.success).toBe(false);
    expect(result.error).toContain("E.164");
    expect(mockHttpPost).not.toHaveBeenCalled();
  });

  it.each(["COMPLETED", "FAILED", "REVERSED"])(
    "does not regress %s to pickup",
    async (status) => {
      mockPrismaFindUnique.mockResolvedValue({ id: "tx", status });
      const dispatch = jest
        .spyOn(anchorSettlementNotificationService, "handleStatusChange")
        .mockResolvedValue([]);
      await anchorWebhookService.processWebhook(
        { transaction: { id: "tx", status: "ready_for_pickup" } },
        undefined,
        "secret",
      );
      expect(mockPrismaUpdate).not.toHaveBeenCalled();
      expect(dispatch).not.toHaveBeenCalled();
      dispatch.mockRestore();
    },
  );

  it("does not notify when a concurrent status change wins", async () => {
    mockPrismaFindUnique.mockResolvedValue({ id: "tx", status: "PENDING" });
    mockPrismaUpdate.mockResolvedValue({ count: 0 });
    const dispatch = jest
      .spyOn(anchorSettlementNotificationService, "handleStatusChange")
      .mockResolvedValue([]);
    await anchorWebhookService.processWebhook(
      { transaction: { id: "tx", status: "ready_for_pickup" } },
      undefined,
      "secret",
    );
    expect(mockPrismaUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "tx", status: "PENDING" } }),
    );
    expect(dispatch).not.toHaveBeenCalled();
    dispatch.mockRestore();
  });

  describe("Recipient Masking", () => {
    it("masks phone numbers correctly", () => {
      expect(service.maskRecipient("+1234567890")).toBe("+12****90");
      expect(service.maskRecipient("123")).toBe("****");
    });

    it("masks email addresses correctly", () => {
      expect(service.maskRecipient("customer@example.com")).toBe(
        "c******r@example.com",
      );
      expect(service.maskRecipient("ab@example.com")).toBe("a*@example.com");
    });
  });

  describe("Recipient Details Resolution", () => {
    it("resolves recipient details from sep31Metadata and transaction", async () => {
      mockPrismaFindUnique.mockResolvedValue({
        id: "tx-settle-1",
        status: "COMPLETED",
        amount: "500.00",
        senderCurrency: "USDC",
        outputAmount: "750000.00",
        receiverCurrency: "NGN",
        reference: "REF-9988",
        provider: "YellowCard",
        sep31Metadata: {
          receiver: {
            first_name: "Amara",
            last_name: "Okonkwo",
            phone_number: "+2348012345678",
            email: "amara@example.com",
            pickup_code: "PICK-4455",
          },
        },
      } as any);

      const details = await service.resolveRecipientDetails("tx-settle-1");

      expect(details).not.toBeNull();
      expect(details?.transactionId).toBe("tx-settle-1");
      expect(details?.amount).toBe(500);
      expect(details?.outputAmount).toBe(750000);
      expect(details?.currency).toBe("USDC");
      expect(details?.receiverCurrency).toBe("NGN");
      expect(details?.recipient.name).toBe("Amara Okonkwo");
      expect(details?.recipient.phone).toBe("+2348012345678");
      expect(details?.recipient.email).toBe("amara@example.com");
      expect(details?.recipient.pickupCode).toBe("PICK-4455");
    });

    it("returns null when transaction does not exist", async () => {
      mockPrismaFindUnique.mockResolvedValue(null);
      const details = await service.resolveRecipientDetails("non-existent");
      expect(details).toBeNull();
    });
  });

  describe("SMS and Email Content Generation", () => {
    const samplePayload = {
      transactionId: "tx-100",
      status: "READY_FOR_PICKUP",
      amount: 100,
      currency: "USDC",
      outputAmount: 150000,
      receiverCurrency: "NGN",
      reference: "SF-NGN-100",
      recipient: {
        name: "Kofi Mensah",
        phone: "+233240001111",
        email: "kofi@example.com",
        pickupCode: "PIN-789",
      },
    };

    it("builds correct SMS message for READY_FOR_PICKUP", () => {
      const sms = service.buildSmsText(samplePayload);
      expect(sms).toContain("READY FOR PICKUP");
      expect(sms).toContain("150000 NGN");
      expect(sms).toContain("PIN-789");
      expect(sms).toContain("SF-NGN-100");
    });

    it("builds correct SMS message for COMPLETED", () => {
      const completedPayload = { ...samplePayload, status: "COMPLETED" };
      const sms = service.buildSmsText(completedPayload);
      expect(sms).toContain("COMPLETED");
      expect(sms).toContain("150000 NGN");
    });

    it("builds HTML and text email content for READY_FOR_PICKUP", () => {
      const email = service.buildEmailContent(samplePayload);
      expect(email.subject).toContain("Funds Ready for Pickup");
      expect(email.text).toContain("Kofi Mensah");
      expect(email.html).toContain("PIN-789");
    });

    it("builds HTML and text email content for COMPLETED", () => {
      const completedPayload = { ...samplePayload, status: "COMPLETED" };
      const email = service.buildEmailContent(completedPayload);
      expect(email.subject).toContain("Payout Completed");
      expect(email.text).toContain("COMPLETED");
    });
  });

  describe("handleStatusChange Dispatch & Metric Logging", () => {
    it("dispatches SMS via Twilio on READY_FOR_PICKUP and logs delivery", async () => {
      mockPrismaFindUnique.mockResolvedValue({
        id: "tx-pickup-1",
        status: "READY_FOR_PICKUP",
        amount: "200.00",
        senderCurrency: "USDC",
        outputAmount: "30000.00",
        receiverCurrency: "KES",
        reference: "REF-KES-1",
        sep31Metadata: {
          receiver: {
            name: "Wanjiku",
            phone: "+254700000000",
            email: null,
          },
        },
      } as any);

      const results = await service.handleStatusChange(
        "tx-pickup-1",
        "READY_FOR_PICKUP",
      );

      expect(results).toHaveLength(1);
      expect(results[0]?.channel).toBe("SMS");
      expect(results[0]?.provider).toBe("TWILIO");
      expect(results[0]?.success).toBe(true);

      // Verify Twilio HTTP call
      expect(mockHttpPost).toHaveBeenCalledTimes(1);
      expect(mockHttpPost).toHaveBeenCalledWith(
        expect.stringContaining("api.twilio.com"),
        expect.stringContaining("READY+FOR+PICKUP"),
        expect.any(Object),
      );

      // Verify PostgreSQL delivery log inserted
      expect(mockPrismaExecuteRawUnsafe).toHaveBeenCalledWith(
        expect.stringContaining("INSERT INTO notification_delivery_logs"),
        expect.any(String), // UUID
        "tx-pickup-1",
        "SMS",
        "TWILIO",
        expect.any(String), // masked recipient
        "DELIVERED",
        "READY_FOR_PICKUP",
        expect.any(Number), // latency
        null,
      );
    });

    it("dispatches both SMS and Email on COMPLETED and logs both deliveries", async () => {
      mockPrismaFindUnique.mockResolvedValue({
        id: "tx-complete-1",
        status: "COMPLETED",
        amount: "50.00",
        senderCurrency: "USDC",
        outputAmount: "600.00",
        receiverCurrency: "GHS",
        reference: "REF-GHS-1",
        sep31Metadata: {
          receiver: {
            name: "Kwame",
            phone: "+233200000000",
            email: "kwame@example.com",
          },
        },
      } as any);

      const results = await service.handleStatusChange(
        "tx-complete-1",
        "COMPLETED",
      );

      expect(results).toHaveLength(2);
      expect(
        results.some((r) => r.channel === "SMS" && r.provider === "TWILIO"),
      ).toBe(true);
      expect(
        results.some((r) => r.channel === "EMAIL" && r.provider === "SENDGRID"),
      ).toBe(true);

      // Two HTTP requests: 1 for Twilio, 1 for SendGrid
      expect(mockHttpPost).toHaveBeenCalledTimes(2);

      // Two database log inserts
      expect(
        mockPrismaExecuteRawUnsafe.mock.calls.filter((args: any) =>
          args[0].includes("INSERT INTO"),
        ),
      ).toHaveLength(2);
    });

    it("handles Twilio HTTP failures and records FAILED status in PostgreSQL", async () => {
      mockPrismaFindUnique.mockResolvedValue({
        id: "tx-fail-1",
        status: "READY_FOR_PICKUP",
        amount: "10.00",
        senderCurrency: "XLM",
        outputAmount: "100.00",
        receiverCurrency: "NGN",
        sep31Metadata: {
          receiver: { phone: "+234800000000" },
        },
      } as any);

      mockHttpPost.mockRejectedValueOnce(
        new Error("Twilio 429 Too Many Requests"),
      );

      const results = await service.handleStatusChange(
        "tx-fail-1",
        "READY_FOR_PICKUP",
      );

      expect(results).toHaveLength(1);
      expect(results[0]?.success).toBe(false);
      expect(results[0]?.error).toBe("Notification provider request failed");

      // Verify PostgreSQL recorded FAILED
      expect(mockPrismaExecuteRawUnsafe).toHaveBeenCalledWith(
        expect.stringContaining("INSERT INTO notification_delivery_logs"),
        expect.any(String),
        "tx-fail-1",
        "SMS",
        "TWILIO",
        expect.any(String),
        "FAILED",
        "READY_FOR_PICKUP",
        expect.any(Number),
        "Notification provider request failed",
      );
    });

    it("ignores non-settlement statuses like PENDING", async () => {
      const results = await service.handleStatusChange("tx-ignored", "PENDING");
      expect(results).toEqual([]);
      expect(mockHttpPost).not.toHaveBeenCalled();
    });
  });

  describe("getDeliverySuccessRateMetrics Aggregations", () => {
    it("computes delivery metrics correctly from PostgreSQL rows", async () => {
      mockPrismaQueryRawUnsafe.mockResolvedValue([
        {
          channel: "SMS",
          status: "DELIVERED",
          status_event: "READY_FOR_PICKUP",
          count: 90,
          avg_latency: 120,
        },
        {
          channel: "SMS",
          status: "FAILED",
          status_event: "READY_FOR_PICKUP",
          count: 10,
          avg_latency: 150,
        },
        {
          channel: "EMAIL",
          status: "DELIVERED",
          status_event: "COMPLETED",
          count: 95,
          avg_latency: 200,
        },
        {
          channel: "EMAIL",
          status: "FAILED",
          status_event: "COMPLETED",
          count: 5,
          avg_latency: 250,
        },
      ]);

      const metrics = await service.getDeliverySuccessRateMetrics({
        timeRangeMinutes: 60,
      });

      expect(metrics.totalDeliveries).toBe(200);
      expect(metrics.successfulDeliveries).toBe(185);
      expect(metrics.failedDeliveries).toBe(15);
      expect(metrics.successRate).toBe(92.5); // 185 / 200 * 100
      expect(metrics.byChannel.SMS.total).toBe(100);
      expect(metrics.byChannel.SMS.successRate).toBe(90);
      expect(metrics.byChannel.EMAIL.total).toBe(100);
      expect(metrics.byChannel.EMAIL.successRate).toBe(95);
      expect(metrics.byEvent["READY_FOR_PICKUP"]?.total).toBe(100);
      expect(metrics.byEvent["COMPLETED"]?.total).toBe(100);
    });

    it("returns 100% success rate when no deliveries recorded yet", async () => {
      mockPrismaQueryRawUnsafe.mockResolvedValue([]);

      const metrics = await service.getDeliverySuccessRateMetrics();

      expect(metrics.totalDeliveries).toBe(0);
      expect(metrics.successRate).toBe(100);
    });
  });

  describe("Integration with AnchorWebhookService", () => {
    it("normalizes ready_for_pickup status and dispatches push notification", async () => {
      const transactionId = "tx-hook-pickup";
      const payload = {
        transaction: {
          id: transactionId,
          status: "ready_for_pickup",
        },
      };

      const rawBody = Buffer.from(JSON.stringify(payload));
      const secret = "test-secret";
      const signature = crypto
        .createHmac("sha256", Buffer.from(secret))
        .update(rawBody)
        .digest("hex");

      mockPrismaFindUnique.mockResolvedValue({
        id: transactionId,
        status: "pending_user_transfer",
        userId: "user-test",
      } as any);

      mockPrismaUpdate.mockResolvedValue({ count: 1 });
      const dispatch = jest
        .spyOn(anchorSettlementNotificationService, "handleStatusChange")
        .mockResolvedValue([]);

      const result = await anchorWebhookService.processWebhook(
        payload,
        signature,
        secret,
      );

      expect(result.success).toBe(true);
      expect(result.newStatus).toBe("READY_FOR_PICKUP");
      expect(dispatch).toHaveBeenCalledWith(
        transactionId,
        "READY_FOR_PICKUP",
        "pending_user_transfer",
      );
      dispatch.mockRestore();
    });
  });
});
