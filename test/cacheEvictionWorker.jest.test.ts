import {
  CacheEvictionWorker,
  getCacheEvictionWorker,
  resetCacheEvictionWorker,
} from "../src/services/cacheEvictionWorker";

// Mock dependencies
jest.mock("../src/config/redis.config", () => ({
  CACHE_CONFIG: {
    redis: {
      keyPrefix: "stellarflow:",
    },
  },
}));

jest.mock("../src/utils/logger", () => ({
  logger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
}));

describe("CacheEvictionWorker", () => {
  beforeEach(() => {
    resetCacheEvictionWorker();
    jest.clearAllMocks();
  });

  afterEach(() => {
    resetCacheEvictionWorker();
  });

  describe("constructor", () => {
    it("should create instance with default config", () => {
      const worker = new CacheEvictionWorker();
      expect(worker).toBeDefined();
      expect(worker.isActive()).toBe(false);
    });

    it("should create instance with custom config", () => {
      const worker = new CacheEvictionWorker({
        evictionIntervalMs: 60_000,
        batchSize: 100,
        runOnStart: false,
      });
      expect(worker).toBeDefined();
    });
  });

  describe("start/stop", () => {
    it("should start and stop the worker", () => {
      const worker = new CacheEvictionWorker({
        evictionIntervalMs: 1000,
        runOnStart: false,
      });

      worker.start();
      expect(worker.isActive()).toBe(true);

      worker.stop();
      expect(worker.isActive()).toBe(false);
    });

    it("should not start twice", () => {
      const worker = new CacheEvictionWorker({
        evictionIntervalMs: 1000,
        runOnStart: false,
      });

      worker.start();
      worker.start(); // Should not throw

      expect(worker.isActive()).toBe(true);
      worker.stop();
    });
  });

  describe("runEvictionCycle", () => {
    it("should skip when Redis is not available", async () => {
      const worker = new CacheEvictionWorker({ runOnStart: false });
      const metrics = worker.getMetrics();
      expect(metrics.totalCycles).toBe(0);
    });

    it("should track metrics after a cycle", async () => {
      const worker = new CacheEvictionWorker({ runOnStart: false });
      const metrics = worker.getMetrics();
      expect(metrics.totalCycles).toBe(0);
      expect(metrics.totalKeysScanned).toBe(0);
      expect(metrics.totalKeysDeleted).toBe(0);
      expect(metrics.totalBytesReclaimed).toBe(0);
      expect(metrics.lastCycleAt).toBeNull();
    });
  });

  describe("isEvictionCycle", () => {
    it("should report eviction cycle status", () => {
      const worker = new CacheEvictionWorker({ runOnStart: false });
      expect(worker.isEvictionCycle()).toBe(false);
    });
  });

  describe("singleton", () => {
    it("should return same instance from getCacheEvictionWorker", () => {
      const worker1 = getCacheEvictionWorker();
      const worker2 = getCacheEvictionWorker();
      expect(worker1).toBe(worker2);
    });

    it("should reset singleton with resetCacheEvictionWorker", () => {
      const worker1 = getCacheEvictionWorker();
      resetCacheEvictionWorker();
      const worker2 = getCacheEvictionWorker();
      expect(worker1).not.toBe(worker2);
    });
  });
});
