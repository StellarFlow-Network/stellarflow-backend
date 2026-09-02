import {
  describe,
  it,
  expect,
  jest,
  beforeAll,
  beforeEach,
} from "@jest/globals";

type Row = Record<string, any>;

const db = {
  paymentRoutes: new Map<string, Row>(),
  fxQuotes: new Map<string, Row>(),
  remittances: new Map<string, Row>(),
  receiptStatuses: [] as string[],
};

const httpPost = jest.fn();
const executeRawUnsafe = jest.fn(async (sql: string, ...params: unknown[]) => {
  const normalized = sql.replace(/\s+/g, " ").trim();
  if (normalized.startsWith("UPDATE anchor_webhook_delivery_receipts")) {
    db.receiptStatuses.push(String(params[0]));
  }
  return { count: 1 };
});

jest.mock("../src/lib/prisma", () => ({
  __esModule: true,
  default: {
    $executeRawUnsafe: executeRawUnsafe,
    paymentRoute: {
      findMany: jest.fn(async ({ where }: { where: Row }) =>
        [...db.paymentRoutes.values()].filter(
          (route) =>
            route.senderCurrency === where.senderCurrency &&
            route.receiverCurrency === where.receiverCurrency &&
            route.status === where.status &&
            (!where.targetRail || route.targetRail === where.targetRail),
        ),
      ),
      findUnique: jest.fn(
        async ({ where }: { where: { id: string } }) =>
          db.paymentRoutes.get(where.id) ?? null,
      ),
    },
    fxQuote: {
      create: jest.fn(async ({ data }: { data: Row }) => {
        const row = {
          id: `quote-${db.fxQuotes.size + 1}`,
          lockedAt: null,
          executedAt: null,
          createdAt: new Date("2026-08-30T10:00:00Z"),
          ...data,
        };
        db.fxQuotes.set(row.id, row);
        return row;
      }),
      findUnique: jest.fn(
        async ({ where }: { where: { id: string } }) =>
          db.fxQuotes.get(where.id) ?? null,
      ),
      update: jest.fn(
        async ({ where, data }: { where: { id: string }; data: Row }) => {
          const existing = db.fxQuotes.get(where.id);
          if (!existing) {
            throw new Error(`FX quote ${where.id} not found`);
          }
          const row = { ...existing, ...data };
          db.fxQuotes.set(where.id, row);
          return row;
        },
      ),
    },
    remittanceTransaction: {
      create: jest.fn(async ({ data }: { data: Row }) => {
        const row = {
          id: `remittance-${db.remittances.size + 1}`,
          createdAt: new Date("2026-08-30T10:01:00Z"),
          updatedAt: new Date("2026-08-30T10:01:00Z"),
          payoutHalted: false,
          ...data,
        };
        db.remittances.set(row.id, row);
        return row;
      }),
      update: jest.fn(
        async ({ where, data }: { where: { id: string }; data: Row }) => {
          const existing = db.remittances.get(where.id);
          if (!existing) {
            throw new Error(`Remittance ${where.id} not found`);
          }
          const row = { ...existing, ...data, updatedAt: new Date() };
          db.remittances.set(where.id, row);
          return row;
        },
      ),
      findUnique: jest.fn(
        async ({ where }: { where: { id: string } }) =>
          db.remittances.get(where.id) ?? null,
      ),
    },
  },
}));

jest.mock("../src/lib/httpClient", () => ({
  __esModule: true,
  httpClient: {
    post: httpPost,
  },
}));

jest.mock("../src/services/marketRate/marketRateService", () => ({
  __esModule: true,
  MarketRateService: class {
    async getRate() {
      return { success: false, error: "mocked" };
    }
  },
}));

jest.mock("../src/services/derivedAssetService", () => ({
  __esModule: true,
  DerivedAssetService: class {
    async getDerivedRate() {
      return { success: false, error: "mocked" };
    }
  },
}));

jest.mock("../src/services/secretManager", () => ({
  __esModule: true,
  getSecretKey: () =>
    "SDO7GT7Y7X7W7V7U7T7S7R7Q7P7O7N7M7L7K7J7I7H7G7F7E7D7C7B7A",
  getPublicKey: () =>
    "GDO7GT7Y7X7W7V7U7T7S7R7Q7P7O7N7M7L7K7J7I7H7G7F7E7D7C7B7A",
}));

jest.mock("../src/signer", () => ({
  __esModule: true,
  signer: {
    sign: jest.fn(),
    getPublicKey: jest.fn(),
  },
}));

jest.mock("../src/lib/redis", () => ({
  __esModule: true,
  redisClient: {
    connect: jest.fn(),
    disconnect: jest.fn(),
    get: jest.fn(),
    set: jest.fn(),
    del: jest.fn(),
  },
}));

jest.mock("../src/services/stellarService", () => ({
  __esModule: true,
  StellarService: class {},
  default: {},
}));

jest.mock("../src/utils/logger", () => ({
  __esModule: true,
  createFetcherLogger: () => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  }),
}));

let prisma: typeof import("../src/lib/prisma").default;
let PaymentRoutingService: typeof import("../src/services/paymentRoutingService").PaymentRoutingService;
let FxConversionService: typeof import("../src/services/fxConversionService").FxConversionService;
let AnchorPayoutRelayService: typeof import("../src/services/anchorPayoutRelayService").AnchorPayoutRelayService;
let AnchorWebhookRelayerService: typeof import("../src/services/anchorWebhookRelayerService").AnchorWebhookRelayerService;
let REMITTANCE_STATUS: typeof import("../src/services/complianceTypes").REMITTANCE_STATUS;
let parseRemittanceDepositEvent: typeof import("../src/services/remittanceDepositEventParser").parseRemittanceDepositEvent;

describe("remittance workflow system integration", () => {
  beforeAll(async () => {
    prisma = (await import("../src/lib/prisma")).default;
    ({ PaymentRoutingService } =
      await import("../src/services/paymentRoutingService"));
    ({ FxConversionService } =
      await import("../src/services/fxConversionService"));
    ({ AnchorPayoutRelayService } =
      await import("../src/services/anchorPayoutRelayService"));
    ({ AnchorWebhookRelayerService } =
      await import("../src/services/anchorWebhookRelayerService"));
    ({ REMITTANCE_STATUS } = await import("../src/services/complianceTypes"));
    ({ parseRemittanceDepositEvent } =
      await import("../src/services/remittanceDepositEventParser"));
  });

  beforeEach(() => {
    db.paymentRoutes.clear();
    db.fxQuotes.clear();
    db.remittances.clear();
    db.receiptStatuses = [];
    jest.clearAllMocks();

    db.paymentRoutes.set("route-ngn-ghs", {
      id: "route-ngn-ghs",
      senderCurrency: "NGN",
      receiverCurrency: "GHS",
      sourceAsset: "XLM",
      targetRail: "MOBILE_MONEY",
      provider: "test-anchor",
      rate: 0.008,
      fee: 5,
      estimatedAmount: 795,
      slippageBps: 20,
      liquidityPoolId: null,
      priority: 10,
      status: "ACTIVE",
    });

    httpPost.mockResolvedValue({ status: 202, data: { accepted: true } });
  });

  it("executes quote, deposit parse, anchor payout, webhook delivery, and DB transitions", async () => {
    const paymentRouting = new PaymentRoutingService();
    const routes = await paymentRouting.findOptimalRoutes({
      senderCurrency: "ngn",
      receiverCurrency: "ghs",
      inputAmount: 100_000,
      targetRail: "mobile_money",
    });

    expect(routes.success).toBe(true);
    expect(routes.routes[0]?.id).toBe("route-ngn-ghs");

    const fx = new FxConversionService(undefined, {
      getDerivedRate: jest.fn(async () => ({
        success: true,
        data: {
          rate: 0.008,
          source: "integration-feed",
          timestamp: new Date("2026-08-30T10:00:00Z"),
        },
      })),
    } as any);

    const quote = await fx.requestQuote("route-ngn-ghs", 100_000);
    expect(quote.success).toBe(true);
    expect(db.fxQuotes.get(quote.quoteId!)?.status).toBe("PENDING");

    const lockedQuote = await fx.lockQuote({ quoteId: quote.quoteId! });
    expect(lockedQuote.status).toBe("LOCKED");
    expect(db.fxQuotes.get(quote.quoteId!)?.lockedAt).toBeInstanceOf(Date);

    const deposit = parseRemittanceDepositEvent({
      topics: ["deposit"],
      txHash: "stellar-tx-818",
      data: {
        user: "user-818",
        token: "XLM",
        amount: 100_000,
        quoteId: quote.quoteId,
      },
    });

    const remittance = await prisma.remittanceTransaction.create({
      data: {
        userId: deposit.user,
        asset: deposit.token,
        senderCurrency: quote.senderCurrency,
        receiverCurrency: quote.receiverCurrency,
        amount: deposit.amount,
        outputAmount: quote.outputAmount,
        fee: quote.fee,
        rate: quote.rate,
        status: REMITTANCE_STATUS.PENDING_SCREENING,
        provider: routes.routes[0]!.provider,
        stellarTxHash: deposit.transactionHash,
        reference: deposit.quoteId,
        senderPublicKey: "GSENDER",
        recipientPublicKey: "GRECIPIENT",
      },
    });

    expect(remittance.status).toBe(REMITTANCE_STATUS.PENDING_SCREENING);

    await prisma.remittanceTransaction.update({
      where: { id: remittance.id },
      data: {
        status: REMITTANCE_STATUS.COMPLIANCE_CLEARED,
        screenedAt: new Date("2026-08-30T10:02:00Z"),
      },
    });

    const payoutCalls: unknown[] = [];
    const payoutRelay = new AnchorPayoutRelayService(
      "https://anchor.example/payouts",
      jest.fn(async (_url, init) => {
        payoutCalls.push(JSON.parse(String(init?.body)));
        return { ok: true, status: 202 } as Response;
      }) as typeof fetch,
    );

    await payoutRelay.relay(db.remittances.get(remittance.id) as any);
    await prisma.remittanceTransaction.update({
      where: { id: remittance.id },
      data: {
        status: REMITTANCE_STATUS.PAYOUT_RELAYED,
        payoutRelayedAt: new Date("2026-08-30T10:03:00Z"),
      },
    });

    await fx.markExecuted(quote.quoteId!);

    const webhookRelayer = new AnchorWebhookRelayerService();
    (webhookRelayer as any).isRunning = true;
    await webhookRelayer.enqueueDelivery({
      eventType: "remittance.payout_relayed",
      endpoint: "https://client.example/webhooks/remittance",
      payload: {
        remittanceId: remittance.id,
        status: REMITTANCE_STATUS.PAYOUT_RELAYED,
      },
      maxAttempts: 1,
    });
    await (webhookRelayer as any).processQueue();

    const finalRemittance = await prisma.remittanceTransaction.findUnique({
      where: { id: remittance.id },
    });
    const finalQuote = await fx.getQuoteStatus(quote.quoteId!);

    expect(finalRemittance?.status).toBe(REMITTANCE_STATUS.PAYOUT_RELAYED);
    expect(finalRemittance?.reference).toBe(quote.quoteId);
    expect(finalRemittance?.stellarTxHash).toBe("stellar-tx-818");
    expect(finalQuote?.status).toBe("EXECUTED");
    expect(payoutCalls).toEqual([
      {
        remittanceId: remittance.id,
        senderPublicKey: "GSENDER",
        recipientPublicKey: "GRECIPIENT",
      },
    ]);
    expect(httpPost).toHaveBeenCalledWith(
      "https://client.example/webhooks/remittance",
      {
        remittanceId: remittance.id,
        status: REMITTANCE_STATUS.PAYOUT_RELAYED,
      },
      expect.objectContaining({ timeout: expect.any(Number) }),
    );
    expect(db.receiptStatuses).toEqual(["queued", "sending", "succeeded"]);
  });
});
