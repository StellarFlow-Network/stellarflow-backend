jest.mock("../src/services/stellarService", () => ({
  StellarService: jest.fn().mockImplementation(() => ({})),
}));

jest.mock("../src/services/multiSigService", () => ({
  multiSigService: {
    createMultiSigRequest: jest.fn().mockResolvedValue({ multiSigPriceId: 1 }),
    signMultiSigPrice: jest.fn().mockResolvedValue(undefined),
  },
}));

jest.mock("../src/services/priceReviewService", () => ({
  priceReviewService: {
    assessRate: jest.fn().mockResolvedValue({
      manualReviewRequired: false,
      reviewRecordId: 1,
      changePercent: 0,
    }),
  },
}));

jest.mock("../src/lib/prisma", () => ({
  default: {
    errorLog: {
      create: jest.fn().mockResolvedValue(undefined),
    },
  },
}));

jest.mock("../src/lib/redis", () => ({
  getRedisClient: jest.fn().mockReturnValue(null),
}));

jest.mock("../src/config/configWatcher", () => ({
  appConfig: {
    cacheDurationMs: 1000,
    batchWindowMs: 1000,
  },
}));

import { MockRateFetcher } from "../src/services/marketRate/mockFetcher";

describe("MockRateFetcher", () => {
  test("returns a plausible NGN market rate", async () => {
    const fetcher = new MockRateFetcher("NGN");
    const metric = await fetcher.fetchRate();

    expect(metric.currency).toBe("NGN");
    expect(metric.rate).toBeGreaterThan(0);
    expect(metric.rate).toBeLessThan(1000);
    expect(metric.source).toContain("Mock Market API");
    expect(metric.timestamp).toBeInstanceOf(Date);
  });

  test("reports healthy status", async () => {
    const fetcher = new MockRateFetcher("KES");
    expect(await fetcher.isHealthy()).toBe(true);
  });
});

describe("MarketRateService with USE_MOCKS enabled", () => {
  beforeEach(() => {
    jest.resetModules();
    process.env.USE_MOCKS = "true";
  });

  afterEach(() => {
    delete process.env.USE_MOCKS;
  });

  test("initializes mock fetchers and returns mock rate data", async () => {
    const { MarketRateService } = await import("../src/services/marketRate/marketRateService");
    const service = new MarketRateService();

    expect(service.getSupportedCurrencies()).toEqual(["KES", "GHS", "NGN"]);

    const response = await service.getRate("GHS");
    expect(response.success).toBe(true);
    expect(response.data).toBeDefined();
    expect(response.data?.currency).toBe("GHS");
    expect(response.data?.source).toContain("Mock Market API");
  });
});
