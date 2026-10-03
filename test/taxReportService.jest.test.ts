import { describe, it, expect } from "@jest/globals";
import express from "express";
import request from "supertest";
import {
  COINTRACKER_HEADER,
  KOINLY_HEADER,
  TaxReportService,
  mapFxQuote,
  mapHarvest,
  mapRemittance,
  renderCsv,
  type TaxEventRow,
  type TaxReportDatabase,
} from "../src/services/taxReportService";
import taxReportRouter from "../src/routes/taxReport";

const fxRow = {
  executedAt: new Date("2026-03-02T10:00:00.000Z"),
  senderCurrency: "XLM",
  receiverCurrency: "USDC",
  inputAmount: "100",
  outputAmount: "12.5",
  fee: "0.5",
  feedSource: "route",
};

const remittanceRow = {
  id: "rm-1",
  createdAt: new Date("2026-03-01T08:00:00.000Z"),
  senderCurrency: "NGN",
  receiverCurrency: "GHS",
  amount: "5000",
  outputAmount: "45",
  fee: "25",
  status: "COMPLETED",
  stellarTxHash: "deadbeef",
};

const harvestRow = {
  strategyId: "GADDRESS",
  asset: "USDC",
  yieldAmount: "10",
  netProfit: "8",
  gasCost: "1",
  status: "EXECUTED",
  executedAt: new Date("2026-03-03T12:00:00.000Z"),
  transactionHash: "cafebabe",
};

function stubDb(): TaxReportDatabase {
  return {
    fxQuote: { findMany: async () => [fxRow] },
    remittanceTransaction: { findMany: async () => [remittanceRow] },
    harvestExecution: { findMany: async () => [harvestRow] },
  };
}

describe("TaxReportService (Issue #1009)", () => {
  it("maps an executed FX quote into a swap row", () => {
    const row = mapFxQuote(fxRow);
    expect(row?.type).toBe("swap");
    expect(row?.sentAsset).toBe("XLM");
    expect(row?.receivedAsset).toBe("USDC");
    expect(row?.receivedAmount).toBe(12.5);
    expect(row?.feeAmount).toBe(0.5);
  });

  it("maps a remittance transaction into a deposit row", () => {
    const row = mapRemittance(remittanceRow);
    expect(row?.type).toBe("deposit");
    expect(row?.txHash).toBe("deadbeef");
    expect(row?.sentAmount).toBe(5000);
  });

  it("maps a harvest execution into a yield row using net profit", () => {
    const row = mapHarvest(harvestRow);
    expect(row?.type).toBe("yield");
    expect(row?.receivedAsset).toBe("USDC");
    expect(row?.receivedAmount).toBe(8);
    expect(row?.feeAmount).toBe(1);
  });

  it("renders CoinTracker CSV rows with the standard header", () => {
    const rows: TaxEventRow[] = [
      {
        date: "2026-03-02T10:00:00.000Z",
        type: "swap",
        sentAsset: "XLM",
        sentAmount: 100,
        receivedAsset: "USDC",
        receivedAmount: 12.5,
        feeAmount: 0.5,
        feeAsset: "XLM",
        description: "Swap XLM to USDC",
        txHash: null,
      },
    ];
    const csv = renderCsv(rows, "cointracker");
    const [header, line] = csv.trim().split("\n");
    expect(header).toBe(COINTRACKER_HEADER.join(","));
    expect(line).toContain("2026-03-02 10:00:00");
    expect(line).toContain("12.5");
    expect(line).toContain("USDC");
    expect(line).toContain("Swap XLM to USDC");
  });

  it("renders Koinly CSV rows with labels and transaction hashes", () => {
    const rows: TaxEventRow[] = [
      {
        date: "2026-03-03T12:00:00.000Z",
        type: "yield",
        sentAsset: null,
        sentAmount: null,
        receivedAsset: "USDC",
        receivedAmount: 8,
        feeAmount: 1,
        feeAsset: "USDC",
        description: "Yield harvest",
        txHash: "cafebabe",
      },
    ];
    const csv = renderCsv(rows, "koinly");
    const [header, line] = csv.trim().split("\n");
    expect(header).toBe(KOINLY_HEADER.join(","));
    expect(line).toContain("reward");
    expect(line).toContain("cafebabe");
  });

  it("collects and chronologically sorts rows from the database", async () => {
    const service = new TaxReportService(stubDb());
    const rows = await service.collectRows({
      address: "GADDRESS",
      format: "cointracker",
    });
    expect(rows).toHaveLength(3);
    expect(rows[0]?.type).toBe("deposit");
    expect(rows[1]?.type).toBe("swap");
    expect(rows[2]?.type).toBe("yield");
  });

  it("supports ISO date filters and produces a report summary", async () => {
    const service = new TaxReportService(stubDb());
    const report = await service.generateReport({
      address: "GADDRESS",
      format: "koinly",
      from: new Date("2026-03-01T00:00:00.000Z"),
      to: new Date("2026-03-31T23:59:59.000Z"),
    });
    expect(report.rowCount).toBe(3);
    expect(report.summary.format).toBe("koinly");
    expect(report.csv.startsWith(KOINLY_HEADER.join(","))).toBe(true);
  });

  it("streams the header first and then batches of rows", async () => {
    const service = new TaxReportService(stubDb());
    const chunks: string[] = [];
    for await (const chunk of service.streamReport(
      { address: "GADDRESS", format: "cointracker" },
      2,
    )) {
      chunks.push(chunk);
    }
    expect(chunks[0]).toBe(`${COINTRACKER_HEADER.join(",")}\n`);
    expect(chunks.length).toBe(3);
    expect(chunks.join("")).toContain("Swap XLM to USDC");
  });

  it("rejects unsupported export formats at the HTTP layer", async () => {
    const app = express();
    app.use("/api/v1/users", taxReportRouter);

    const response = await request(app).get(
      "/api/v1/users/GADDRESS/tax-report?format=bogus",
    );
    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe("VALIDATION_ERROR");
  });

  it("rejects invalid ISO date filters", async () => {
    const app = express();
    app.use("/api/v1/users", taxReportRouter);

    const response = await request(app).get(
      "/api/v1/users/GADDRESS/tax-report?from=not-a-date",
    );
    expect(response.status).toBe(400);
    expect(response.body.error.message).toContain("from");
  });
});
