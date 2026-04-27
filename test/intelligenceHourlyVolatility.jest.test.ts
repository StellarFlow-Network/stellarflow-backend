import { IntelligenceService } from "../src/services/intelligenceService";

describe("IntelligenceService hourly volatility snapshot", () => {
  test("calculates population standard deviation for the last 60 minutes", async () => {
    const mockDb = {
      currency: {
        findMany: jest.fn().mockResolvedValue([
          { code: "GHS" },
          { code: "KES" },
          { code: "NGN" },
        ]),
      },
      priceHistory: {
        findMany: jest.fn().mockResolvedValue([
          {
            currency: "GHS",
            rate: "50",
            timestamp: new Date("2026-04-24T11:10:00.000Z"),
          },
          {
            currency: "GHS",
            rate: "50",
            timestamp: new Date("2026-04-24T11:35:00.000Z"),
          },
          {
            currency: "NGN",
            rate: "100",
            timestamp: new Date("2026-04-24T11:05:00.000Z"),
          },
          {
            currency: "NGN",
            rate: "110",
            timestamp: new Date("2026-04-24T11:25:00.000Z"),
          },
          {
            currency: "NGN",
            rate: "90",
            timestamp: new Date("2026-04-24T11:55:00.000Z"),
          },
        ]),
      },
    };

    const service = new IntelligenceService(mockDb as any);
    const now = new Date("2026-04-24T12:00:00.000Z");

    const snapshot = await service.getHourlyVolatilitySnapshot(now);

    expect(mockDb.currency.findMany).toHaveBeenCalledWith({
      where: { isActive: true },
      select: { code: true },
      orderBy: { code: "asc" },
    });
    expect(mockDb.priceHistory.findMany).toHaveBeenCalledWith({
      where: {
        currency: {
          in: ["GHS", "KES", "NGN"],
        },
        timestamp: {
          gte: new Date("2026-04-24T11:00:00.000Z"),
          lte: now,
        },
      },
      orderBy: [{ currency: "asc" }, { timestamp: "asc" }],
      select: {
        currency: true,
        rate: true,
        timestamp: true,
      },
    });

    expect(snapshot.windowMinutes).toBe(60);
    expect(snapshot.generatedAt.toISOString()).toBe("2026-04-24T12:00:00.000Z");
    expect(snapshot.windowStart.toISOString()).toBe("2026-04-24T11:00:00.000Z");
    expect(snapshot.windowEnd.toISOString()).toBe("2026-04-24T12:00:00.000Z");
    expect(snapshot.currencies[0]).toEqual({
      currency: "GHS",
      standardDeviation: 0,
      sampleCount: 2,
      meanRate: 50,
      latestRate: 50,
      latestTimestamp: new Date("2026-04-24T11:35:00.000Z"),
    });
    expect(snapshot.currencies[1]).toEqual({
      currency: "KES",
      standardDeviation: 0,
      sampleCount: 0,
      meanRate: null,
      latestRate: null,
      latestTimestamp: null,
    });
    expect(snapshot.currencies[2]).toEqual({
      currency: "NGN",
      standardDeviation: expect.any(Number),
      sampleCount: 3,
      meanRate: 100,
      latestRate: 90,
      latestTimestamp: new Date("2026-04-24T11:55:00.000Z"),
    });
    expect(snapshot.currencies[2]?.standardDeviation).toBeCloseTo(
      8.1649658093,
      10,
    );
  });

  test("returns an empty snapshot when there are no active currencies", async () => {
    const mockDb = {
      currency: {
        findMany: jest.fn().mockResolvedValue([]),
      },
      priceHistory: {
        findMany: jest.fn(),
      },
    };

    const service = new IntelligenceService(mockDb as any);
    const snapshot = await service.getHourlyVolatilitySnapshot(
      new Date("2026-04-24T12:00:00.000Z"),
    );

    expect(snapshot.currencies).toEqual([]);
    expect(snapshot.generatedAt.toISOString()).toBe("2026-04-24T12:00:00.000Z");
    expect(mockDb.priceHistory.findMany).not.toHaveBeenCalled();
  });
});
