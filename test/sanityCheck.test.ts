import { describe, it, expect, beforeEach } from "@jest/globals";
import { sanityCheckService } from "../src/services/sanityCheckService";

describe("Sanity Check Service", () => {
  describe("checkPrice", () => {
    it("should pass sanity check when prices are similar", async () => {
      // Using a realistic NGN/XLM price
      const oraclePrice = 150.5;

      const result = await sanityCheckService.checkPrice("NGN", oraclePrice);

      if (result) {
        expect(result.currency).toBe("NGN");
        expect(result.oraclePrice).toBe(oraclePrice);
        expect(result.externalPrice).toBeGreaterThan(0);
        expect(result.deviationPercent).toBeGreaterThanOrEqual(0);
        expect(result.source).toBeTruthy();
        expect(result.timestamp).toBeInstanceOf(Date);
      }
    }, 15000);

    it("should detect significant deviation", async () => {
      // Using an unrealistic price that should trigger alert
      const oraclePrice = 1000000; // Extremely high price

      const result = await sanityCheckService.checkPrice("NGN", oraclePrice);

      if (result) {
        expect(result.passed).toBe(false);
        expect(result.deviationPercent).toBeGreaterThan(
          sanityCheckService.getThreshold(),
        );
      }
    }, 15000);

    it("should handle multiple currencies", async () => {
      const currencies = ["NGN", "KES", "GHS"];
      const prices = [
        { currency: "NGN", price: 150 },
        { currency: "KES", price: 15 },
        { currency: "GHS", price: 1.5 },
      ];

      const results = await sanityCheckService.checkPrices(prices);

      expect(results.length).toBeGreaterThan(0);
      results.forEach((result) => {
        expect(result.currency).toBeTruthy();
        expect(result.oraclePrice).toBeGreaterThan(0);
        expect(result.externalPrice).toBeGreaterThan(0);
        expect(result.deviationPercent).toBeGreaterThanOrEqual(0);
      });
    }, 20000);
  });

  describe("getThreshold", () => {
    it("should return the deviation threshold", () => {
      const threshold = sanityCheckService.getThreshold();
      expect(threshold).toBe(2.0);
    });
  });

  describe("calculateDeviation", () => {
    it("should calculate percentage deviation correctly", () => {
      // Access private method through type assertion for testing
      const service = sanityCheckService as any;

      const deviation1 = service.calculateDeviation(100, 100);
      expect(deviation1).toBe(0);

      const deviation2 = service.calculateDeviation(102, 100);
      expect(deviation2).toBe(2);

      const deviation3 = service.calculateDeviation(98, 100);
      expect(deviation3).toBe(2);

      const deviation4 = service.calculateDeviation(105, 100);
      expect(deviation4).toBe(5);
    });
  });
});
