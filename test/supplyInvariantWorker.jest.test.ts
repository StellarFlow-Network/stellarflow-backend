import { SupplyInvariantCheckerWorker } from "../src/services/supplyInvariantWorker";
import { notificationService } from "../src/services/notificationService";

jest.mock("../src/services/secretManager", () => ({
  getSecretKey: jest.fn(() => "SD36N35F53L5J5L5J5L5J5L5J5L5J5L5J5L5J5L5J5L5J5L5J5L5J5L5"),
  getPublicKey: jest.fn(() => "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"),
  registerSecret: jest.fn(),
  getSecretKeyOrNull: jest.fn(() => "SD36N35F53L5J5L5J5L5J5L5J5L5J5L5J5L5J5L5J5L5J5L5J5L5J5L5"),
}));

jest.mock("../src/services/circuitBreakerService", () => ({
  circuitBreakerService: {
    evaluateAndTriggerPause: jest.fn(() => Promise.resolve()),
  },
}));

jest.mock("../src/lib/prisma", () => ({
  prisma: {
    poolLiquidity: {
      findMany: jest.fn(() =>
        Promise.resolve([
          { poolId: "POOL-XLM-USDC", liquidity: "10000.0000" },
          { poolId: "POOL-XLM-NGN", liquidity: "50000.0000" },
        ]),
      ),
    },
    circuitBreakerEvent: {
      create: jest.fn(() => Promise.resolve({ id: 1 })),
    },
  },
}));

describe("Issue #747: Continuous Supply Invariant Checker Worker", () => {
  let worker: SupplyInvariantCheckerWorker;

  beforeEach(() => {
    worker = new SupplyInvariantCheckerWorker({
      checkIntervalMs: 1000,
      varianceThresholdPercent: 0.01,
    });
  });

  afterEach(() => {
    worker.stop();
  });

  describe("evaluatePoolSupplyInvariant", () => {
    it("returns no drift when physical and internal balances match exactly", () => {
      const result = worker.evaluatePoolSupplyInvariant("POOL-1", 1000, 1000);
      expect(result.hasDrift).toBe(false);
      expect(result.variance).toBe(0);
      expect(result.variancePercent).toBe(0);
    });

    it("returns no drift when variance is within configured threshold", () => {
      // 0.005% variance is below 0.01% threshold
      const result = worker.evaluatePoolSupplyInvariant("POOL-1", 1000.05, 1000);
      expect(result.hasDrift).toBe(false);
      expect(result.variancePercent).toBeLessThan(0.01);
    });

    it("detects supply invariant drift when physical balance deviates significantly from internal ledger", () => {
      // 5% variance is above 0.01% threshold
      const result = worker.evaluatePoolSupplyInvariant("POOL-1", 1050, 1000);
      expect(result.hasDrift).toBe(true);
      expect(result.variance).toBe(50);
      expect(result.variancePercent).toBe(5);
    });

    it("throws error if balance inputs are invalid numbers", () => {
      expect(() =>
        worker.evaluatePoolSupplyInvariant("POOL-1", NaN, 1000),
      ).toThrow("Balances must be finite numbers");
    });
  });

  describe("handleInvariantBreach", () => {
    it("dispatches high-priority PagerDuty / webhook alert on invariant breach", async () => {
      const sendAlertSpy = jest
        .spyOn(notificationService, "sendSupplyInvariantDriftAlert")
        .mockResolvedValue(true);

      const comparison = {
        poolId: "POOL-TEST",
        physicalBalance: 1050,
        internalBalance: 1000,
        variance: 50,
        variancePercent: 5,
        hasDrift: true,
        blockHeight: 123456,
      };

      await worker.handleInvariantBreach(comparison);

      expect(sendAlertSpy).toHaveBeenCalledWith({
        poolId: "POOL-TEST",
        physicalBalance: 1050,
        internalBalance: 1000,
        variancePercent: 5,
        blockHeight: 123456,
      });

      sendAlertSpy.mockRestore();
    });
  });

  describe("worker lifecycle (start / stop)", () => {
    it("starts and stops worker cleanly", () => {
      worker.start();
      expect(worker.getStatus().isRunning).toBe(true);

      worker.stop();
      expect(worker.getStatus().isRunning).toBe(false);
    });
  });
});
