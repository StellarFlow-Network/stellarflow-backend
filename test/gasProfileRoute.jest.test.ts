/**
 * Issue #786 – read API for daily gas/CPU averages.
 * Exercises the Express route with a mocked profiler service.
 */
import {
  describe,
  it,
  expect,
  beforeEach,
  afterEach,
  jest,
} from "@jest/globals";
import express from "express";
import type { Server } from "http";
import type { AddressInfo } from "net";

const getDailyAverages = jest.fn<() => Promise<unknown[]>>();
const getStatus = jest.fn<() => Record<string, unknown>>();

jest.unstable_mockModule(
  "../src/services/gasProfiler/gasProfilerService.js",
  () => ({
    getGasProfilerService: () => ({
      getDailyAverages,
      getStatus,
    }),
  }),
);

const { default: gasProfileRouter } =
  await import("../src/routes/gasProfile.js");

let server: Server;
let baseUrl: string;

beforeEach(async () => {
  getDailyAverages.mockReset();
  getStatus.mockReset();

  getDailyAverages.mockResolvedValue([
    {
      day: new Date("2026-03-04T00:00:00Z"),
      txType: "swap",
      sampleCount: 12,
      avgCpuInstructions: 2_000_000,
      avgFeeChargedStroops: 50_000,
      avgRentFeeStroops: 5_000,
      avgDiskReadBytes: 1_000,
      avgWriteBytes: 400,
      maxCpuInstructions: 4_000_000,
      totalFeeChargedStroops: "600000",
    },
  ]);
  getStatus.mockReturnValue({
    isRunning: true,
    enabled: true,
    backfillIntervalMs: 300_000,
    lastProcessedLedger: 55_000,
    contractId: "C_CONTRACT",
  });

  const app = express();
  app.use("/api/v1/gas-profile", gasProfileRouter);
  server = app.listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  const { port } = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${port}`;
});

afterEach(async () => {
  await new Promise((resolve) => server.close(resolve));
});

describe("GET /api/v1/gas-profile", () => {
  it("returns daily averages with XLM conversions", async () => {
    const res = await fetch(`${baseUrl}/api/v1/gas-profile`);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.data.count).toBe(1);
    expect(body.data.averages[0]).toMatchObject({
      day: "2026-03-04",
      txType: "swap",
      sampleCount: 12,
      avgCpuInstructions: 2_000_000,
      avgFeeChargedXlm: 0.005,
      avgRentFeeXlm: 0.0005,
    });
    expect(getDailyAverages).toHaveBeenCalled();
  });

  it("rejects an unknown txType", async () => {
    const res = await fetch(`${baseUrl}/api/v1/gas-profile?txType=transfer`);
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(body.error.code).toBe("VALIDATION_ERROR");
    expect(getDailyAverages).not.toHaveBeenCalled();
  });

  it("rejects a malformed from date", async () => {
    const res = await fetch(`${baseUrl}/api/v1/gas-profile?from=not-a-date`);
    expect(res.status).toBe(400);
  });

  it("forwards filters to the service", async () => {
    await fetch(
      `${baseUrl}/api/v1/gas-profile?txType=deposit&from=2026-03-01&to=2026-03-04&limit=10`,
    );

    expect(getDailyAverages).toHaveBeenCalledWith(
      expect.objectContaining({
        txType: "deposit",
        limit: 10,
        from: expect.any(Date),
        to: expect.any(Date),
      }),
    );
  });
});

describe("GET /api/v1/gas-profile/status", () => {
  it("returns the worker status", async () => {
    const res = await fetch(`${baseUrl}/api/v1/gas-profile/status`);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.data).toMatchObject({
      isRunning: true,
      contractId: "C_CONTRACT",
    });
  });
});
