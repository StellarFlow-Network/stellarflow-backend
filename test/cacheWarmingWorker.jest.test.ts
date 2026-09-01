import {
  CacheWarmingWorker,
  getCacheWarmingWorker,
  resetCacheWarmingWorker,
} from "../src/services/cacheWarmingWorker";

// Mock dependencies
jest.mock("../src/cache/CacheService", () => ({
  cacheService: {
    set: jest.fn().mockResolvedValue(undefined),
    get: jest.fn().mockResolvedValue(null),
    delete: jest.fn().mockResolvedValue(undefined),
  },
}));

jest.mock("../src/config/redis.config", () => ({
  CACHE_CONFIG: {
    ttl: {
      marketRates: 300,
      history: 1800,
      stats: 600,
      assets: 1800,
    },
  },
  CACHE_KEYS: {
    marketRates: {
      all: () => "market-rates:all",
      single: (currency: string) => `market-rates:${currency}`,
      latest: () => "market-rates:latest",
      health: () => "market-rates:health",
      currencies: () => "market-rates:currencies",
      pendingReviews: () => "market-rates:reviews:pending",
    },
  },
}));

jest.mock("../src/services/marketRate", () => ({
  MarketRateService: jest.fn().mockImplementation(() => ({
    getLatestPrices: jest.fn().mockResolvedValue({
      success: true,
      data: [
        { currency: "KES", rate: 150.5, timestamp: new Date(), source: "test" },
      ],
    }),
    getAllRates: jest
      .fn()
      .mockResolvedValue([
        {
          success: true,
          data: {
            currency: "KES",
            rate: 150.5,
            timestamp: new Date(),
            source: "test",
          },
        },
      ]),
    getSupportedCurrencies: jest.fn().mockReturnValue(["KES", "GHS", "NGN"]),
    healthCheck: jest
      .fn()
      .mockResolvedValue({ KES: true, GHS: true, NGN: true }),
    getCacheStatus: jest.fn().mockReturnValue({ KES: { cached: true } }),
  })),
}));

jest.mock("../src/lib/prisma", () => ({
  default: {
    $disconnect: jest.fn(),
  },
}));

jest.mock("../src/lib/redis", () => ({
  getRedisClient: jest.fn().mockReturnValue(null),
}));

jest.mock("../src/utils/logger", () => ({
  logger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
}));

describe("CacheWarmingWorker", () => {
  beforeEach(() => {
    resetCacheWarmingWorker();
    jest.clearAllMocks();
  });

  afterEach(() => {
    resetCacheWarmingWorker();
  });

  describe("constructor", () => {
    it("should create instance with default config", () => {
      const worker = new CacheWarmingWorker();
      expect(worker).toBeDefined();
      expect(worker.isActive()).toBe(false);
    });

    it("should create instance with custom config", () => {
      const worker = new CacheWarmingWorker({
        warmingIntervalMs: 60_000,
        warmOnLedger: false,
      });
      expect(worker).toBeDefined();
    });
  });

  describe("start/stop", () => {
    it("should start and stop the worker", () => {
      const worker = new CacheWarmingWorker({ warmingIntervalMs: 1000 });

      worker.start();
      expect(worker.isActive()).toBe(true);

      worker.stop();
      expect(worker.isActive()).toBe(false);
    });

    it("should not start twice", () => {
      const worker = new CacheWarmingWorker({ warmingIntervalMs: 1000 });

      worker.start();
      worker.start(); // Should not throw

      expect(worker.isActive()).toBe(true);
      worker.stop();
    });
  });

  describe("onNewLedger", () => {
    it("should trigger warming cycle on new ledger", async () => {
      const worker = new CacheWarmingWorker({ warmOnLedger: true });
      worker.start();

      // Wait for initial warming cycle to complete
      await new Promise((resolve) => setTimeout(resolve, 200));

      await worker.onNewLedger(12345);

      const metrics = worker.getMetrics();
      expect(metrics.ledgerTriggeredCycles).toBe(1);
      expect(metrics.lastLedgerTriggeredAt).toBeDefined();

      worker.stop();
    });

    it("should not trigger if warmOnLedger is disabled", async () => {
      const worker = new CacheWarmingWorker({ warmOnLedger: false });
      worker.start();

      await worker.onNewLedger(12345);

      const metrics = worker.getMetrics();
      expect(metrics.ledgerTriggeredCycles).toBe(0);

      worker.stop();
    });

    it("should not trigger if worker is not running", async () => {
      const worker = new CacheWarmingWorker({ warmOnLedger: true });

      await worker.onNewLedger(12345);

      const metrics = worker.getMetrics();
      expect(metrics.ledgerTriggeredCycles).toBe(0);
    });
  });

  describe("metrics", () => {
    it("should track warming metrics", async () => {
      const worker = new CacheWarmingWorker({ warmingIntervalMs: 1000 });
      worker.start();

      // Wait for initial warming cycle
      await new Promise((resolve) => setTimeout(resolve, 100));

      const metrics = worker.getMetrics();
      expect(metrics.totalCycles).toBeGreaterThanOrEqual(1);
      expect(metrics.successfulWarmedKeys).toBeGreaterThan(0);
      expect(metrics.averageCycleDurationMs).toBeGreaterThanOrEqual(0);

      worker.stop();
    });
  });

  describe("singleton", () => {
    it("should return same instance from getCacheWarmingWorker", () => {
      const worker1 = getCacheWarmingWorker();
      const worker2 = getCacheWarmingWorker();
      expect(worker1).toBe(worker2);
    });

    it("should reset singleton with resetCacheWarmingWorker", () => {
      const worker1 = getCacheWarmingWorker();
      resetCacheWarmingWorker();
      const worker2 = getCacheWarmingWorker();
      expect(worker1).not.toBe(worker2);
    });
  });

  describe("isWarmingCycle", () => {
    it("should report warming cycle status", () => {
      const worker = new CacheWarmingWorker();
      expect(worker.isWarmingCycle()).toBe(false);
    });
  });
});
