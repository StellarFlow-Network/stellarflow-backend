import {
  OrderBookDepthSnapshotExporter,
  getOrderBookDepthSnapshotExporter,
  resetOrderBookDepthSnapshotExporter,
} from "../src/services/orderBookDepthSnapshotExporter";

describe("OrderBookDepthSnapshotExporter", () => {
  beforeEach(() => {
    resetOrderBookDepthSnapshotExporter();
    jest.clearAllMocks();
  });

  it("should rank top bid and ask levels and keep the required schema fields", () => {
    const exporter = new OrderBookDepthSnapshotExporter({
      enabled: true,
      topLevelsPerSide: 50,
      exportIntervalLedgers: 10,
      bucketName: "stellarflow-analytics-orderbook",
      s3Prefix: "test/orderbook-depth",
    });

    const snapshot = {
      version: 1,
      ledgerSeq: 120,
      capturedAt: new Date("2026-01-01T00:00:00.000Z").toISOString(),
      bids: [
        { price: 105, amount: 10 },
        { price: 100, amount: 2 },
        { price: 101, amount: 4 },
        { price: 90, amount: 7 },
      ],
      asks: [
        { price: 110, amount: 5 },
        { price: 111, amount: 3 },
        { price: 109, amount: 1 },
        { price: 120, amount: 6 },
      ],
    };

    const rows = exporter.buildExportRows(snapshot);

    expect(rows).toHaveLength(8);
    expect(rows.filter((row) => row.side === "bid").map((row) => row.price)).toEqual([
      105, 101, 100, 90,
    ]);
    expect(rows.filter((row) => row.side === "ask").map((row) => row.price)).toEqual([
      109, 110, 111, 120,
    ]);
    expect(rows[0]).toMatchObject({
      ledger_seq: 120,
      side: "bid",
      level_index: 1,
      price: 105,
      amount: 10,
    });

    const validation = exporter.validateExportSchema(rows);
    expect(validation.valid).toBe(true);
    expect(validation.missingColumns).toEqual([]);
  });

  it("should export snapshots on the configured interval and surface a daily health report", async () => {
    const exporter = getOrderBookDepthSnapshotExporter({
      enabled: true,
      exportIntervalLedgers: 10,
      bucketName: "stellarflow-analytics-orderbook",
      s3Prefix: "test/orderbook-depth",
      s3Client: {
        send: jest.fn().mockResolvedValue({}),
      } as any,
    });

    const snapshot = {
      version: 1,
      ledgerSeq: 130,
      capturedAt: new Date("2026-01-01T00:00:00.000Z").toISOString(),
      bids: [{ price: 99, amount: 4 }],
      asks: [{ price: 101, amount: 5 }],
    };

    const result = await exporter.exportSnapshot(snapshot);
    expect(result).not.toBeNull();
    expect(result?.key).toContain("ledger_130.parquet");

    const healthReport = await exporter.runDailyHealthCheck();
    expect(healthReport.ok).toBe(true);
    expect(healthReport.requiredFields).toEqual([
      "ledger_seq",
      "captured_at",
      "side",
      "level_index",
      "price",
      "amount",
    ]);
  });
});
