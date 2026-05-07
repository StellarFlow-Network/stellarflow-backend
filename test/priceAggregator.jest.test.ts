/**
 * Tests for Issue #208 – Analytics | Time-Series Data Aggregation Service
 *
 * Test coverage:
 *   1. PriceAggregatorService – unit tests (mocked Prisma)
 *      a. floorToWindow helper via aggregateGranularity side-effects
 *      b. Upserts a candle when ticks exist
 *      c. Skips upsert when no ticks exist in a window
 *      d. Handles currency list being empty
 *      e. start() / stop() lifecycle management
 *
 *   2. GET /api/v1/analytics/ohlc – HTTP integration tests (mocked Prisma)
 *      a. 400 when `currency` is missing
 *      b. 400 when `granularity` is missing
 *      c. 400 for unrecognised granularity
 *      d. 400 when `from` >= `to`
 *      e. 400 for invalid `limit`
 *      f. 200 with correct candle shape when data exists
 *      g. 200 with empty candles array when no data
 *
 *   3. GET /api/v1/analytics/status
 *      a. Returns { isRunning: false } before start()
 */

import {
  jest,
  describe,
  it,
  expect,
  beforeAll,
  beforeEach,
  afterAll,
} from "@jest/globals";
import assert from "node:assert";
import http from "node:http";
import { AddressInfo } from "node:net";

// ── Prisma mock ────────────────────────────────────────────────────────────────

const mockFindMany = jest.fn() as any;
const mockUpsert = jest.fn() as any;

jest.unstable_mockModule("../src/lib/prisma", () => ({
  __esModule: true,
  default: {
    currency: {
      findMany: jest.fn() as any,
    },
    priceHistory: {
      findMany: mockFindMany,
    },
    ohlcCandle: {
      findMany: jest.fn() as any,
      upsert: mockUpsert,
    },
    relayer: {
      findFirst: jest.fn().mockResolvedValue(null) as any,
    },
    apiKey: {
      findUnique: jest.fn().mockResolvedValue({
        id: "test-id",
        label: "test-label",
        scopes: ["read", "write"],
        isActive: true,
        expiresAt: null,
      }) as any,
      update: jest.fn().mockResolvedValue({}) as any,
    },
  },
}));

jest.unstable_mockModule("../src/services/secretManager", () => ({
  __esModule: true,
  getSecretKey: () =>
    "SDO7GT7Y7X7W7V7U7T7S7R7Q7P7O7N7M7L7K7J7I7H7G7F7E7D7C7B7A",
  getPublicKey: () =>
    "GDO7GT7Y7X7W7V7U7T7S7R7Q7P7O7N7M7L7K7J7I7H7G7F7E7D7C7B7A",
  updateSecretKey: jest.fn(),
  getReloadCount: () => 0,
}));

const mockMiddleware = jest.fn((req: any, res: any, next: any) => next());

jest.unstable_mockModule("../src/routes/admin", () => ({
  __esModule: true,
  default: mockMiddleware,
}));
jest.unstable_mockModule("../src/routes/assets", () => ({
  __esModule: true,
  default: mockMiddleware,
}));
jest.unstable_mockModule("../src/routes/derivedAssets", () => ({
  __esModule: true,
  default: mockMiddleware,
}));
jest.unstable_mockModule("../src/routes/history", () => ({
  __esModule: true,
  default: mockMiddleware,
}));
jest.unstable_mockModule("../src/routes/intelligence", () => ({
  __esModule: true,
  default: mockMiddleware,
}));
jest.unstable_mockModule("../src/routes/marketRates", () => ({
  __esModule: true,
  default: mockMiddleware,
}));
jest.unstable_mockModule("../src/routes/priceUpdates", () => ({
  __esModule: true,
  default: mockMiddleware,
}));
jest.unstable_mockModule("../src/routes/sanityCheck", () => ({
  __esModule: true,
  default: mockMiddleware,
}));
jest.unstable_mockModule("../src/routes/stats", () => ({
  __esModule: true,
  default: mockMiddleware,
}));
jest.unstable_mockModule("../src/routes/status", () => ({
  __esModule: true,
  default: mockMiddleware,
}));
jest.unstable_mockModule("../src/routes/systemControl", () => ({
  __esModule: true,
  default: mockMiddleware,
}));
jest.unstable_mockModule("../src/routes/systemFailover", () => ({
  __esModule: true,
  default: mockMiddleware,
}));
jest.unstable_mockModule("../src/cache/CacheMetrics", () => ({
  __esModule: true,
  default: mockMiddleware,
}));

jest.unstable_mockModule("../src/signer", () => ({
  __esModule: true,
  signer: {
    sign: jest.fn().mockResolvedValue("dummy_signature"),
    getPublicKey: jest.fn().mockResolvedValue("dummy_public_key"),
  },
}));

// ── helpers ───────────────────────────────────────────────────────────────────

type JsonResponse = { statusCode: number; body: any };

async function requestJson(
  port: number,
  path: string,
  options: { method?: string; headers?: Record<string, string> } = {},
): Promise<JsonResponse> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: "127.0.0.1",
        port,
        path,
        method: options.method ?? "GET",
        headers: options.headers,
      },
      (res) => {
        let raw = "";
        res.on("data", (chunk) => (raw += chunk));
        res.on("end", () => {
          try {
            resolve({ statusCode: res.statusCode ?? 0, body: JSON.parse(raw) });
          } catch (e) {
            reject(e);
          }
        });
      },
    );
    req.on("error", reject);
    req.end();
  });
}

async function withServer(
  app: any,
  fn: (port: number) => Promise<void>,
): Promise<void> {
  const server = app.listen(0);
  const { port } = server.address() as AddressInfo;
  try {
    await fn(port);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((err: any) => (err ? reject(err) : resolve())),
    );
  }
}

// ── 1. PriceAggregatorService unit tests ─────────────────────────────────────

describe("PriceAggregatorService", () => {
  let prisma: any;
  let PriceAggregatorService: typeof import("../src/services/priceAggregatorService").PriceAggregatorService;

  beforeAll(async () => {
    prisma = (await import("../src/lib/prisma")).default;
    ({ PriceAggregatorService } =
      await import("../src/services/priceAggregatorService"));
  });

  beforeEach(() => {
    jest.clearAllMocks();
  });

  // 1a. Upserts when ticks exist -------------------------------------------------
  it("upserts a candle when PriceHistory ticks are found in the window", async () => {
    const currency = "NGN";
    const now = new Date();

    prisma.currency.findMany.mockResolvedValue([{ code: currency }]);
    mockFindMany.mockResolvedValue([
      { rate: "1500.00", timestamp: new Date(now.getTime() - 30_000) },
      { rate: "1520.00", timestamp: new Date(now.getTime() - 10_000) },
      { rate: "1510.00", timestamp: now },
    ]);
    mockUpsert.mockResolvedValue({});

    const svc = new PriceAggregatorService([
      {
        granularity: "MINUTE",
        windowMs: 60_000,
        lookbackCount: 0,
        cronIntervalMs: 60_000,
      },
    ]);

    // Call the public aggregation method once directly
    await (svc as any).aggregateGranularity({
      granularity: "MINUTE",
      windowMs: 60_000,
      lookbackCount: 0,
      cronIntervalMs: 60_000,
    });

    expect(mockUpsert).toHaveBeenCalledTimes(1);
    const call = mockUpsert.mock.calls[0][0];

    expect(call.where.currency_granularity_openTime.currency).toBe(currency);
    expect(call.where.currency_granularity_openTime.granularity).toBe("MINUTE");
    expect(call.create.open).toBeCloseTo(1500, 1);
    expect(call.create.high).toBeCloseTo(1520, 1);
    expect(call.create.low).toBeCloseTo(1500, 1);
    expect(call.create.close).toBeCloseTo(1510, 1);
    expect(call.create.count).toBe(3);
  });

  // 1b. Skips upsert when no ticks -----------------------------------------------
  it("does NOT upsert when no ticks exist in the window", async () => {
    prisma.currency.findMany.mockResolvedValue([{ code: "KES" }]);
    mockFindMany.mockResolvedValue([]); // no ticks

    const svc = new PriceAggregatorService([
      {
        granularity: "HOUR",
        windowMs: 3_600_000,
        lookbackCount: 0,
        cronIntervalMs: 300_000,
      },
    ]);

    await (svc as any).aggregateGranularity({
      granularity: "HOUR",
      windowMs: 3_600_000,
      lookbackCount: 0,
      cronIntervalMs: 300_000,
    });

    expect(mockUpsert).not.toHaveBeenCalled();
  });

  // 1c. Empty currencies ---------------------------------------------------------
  it("returns early when there are no active currencies", async () => {
    prisma.currency.findMany.mockResolvedValue([]);

    const svc = new PriceAggregatorService([
      {
        granularity: "DAY",
        windowMs: 86_400_000,
        lookbackCount: 0,
        cronIntervalMs: 900_000,
      },
    ]);

    await (svc as any).aggregateGranularity({
      granularity: "DAY",
      windowMs: 86_400_000,
      lookbackCount: 0,
      cronIntervalMs: 900_000,
    });

    expect(mockFindMany).not.toHaveBeenCalled();
    expect(mockUpsert).not.toHaveBeenCalled();
  });

  // 1d. lookbackCount covers multiple windows ------------------------------------
  it("processes (lookbackCount + 1) windows per currency", async () => {
    prisma.currency.findMany.mockResolvedValue([{ code: "GHS" }]);
    mockFindMany.mockResolvedValue([{ rate: "10.00", timestamp: new Date() }]);
    mockUpsert.mockResolvedValue({});

    const svc = new PriceAggregatorService();

    await (svc as any).aggregateGranularity({
      granularity: "MINUTE",
      windowMs: 60_000,
      lookbackCount: 4, // 5 windows total (i = 0..4)
      cronIntervalMs: 60_000,
    });

    // 1 currency × 5 windows = 5 upserts
    expect(mockUpsert).toHaveBeenCalledTimes(5);
  });

  // 1e. Lifecycle ----------------------------------------------------------------
  it("start() sets isRunning to true and stop() sets it to false", async () => {
    prisma.currency.findMany.mockResolvedValue([]);

    const svc = new PriceAggregatorService([
      {
        granularity: "MINUTE",
        windowMs: 60_000,
        lookbackCount: 0,
        cronIntervalMs: 999_999_999, // won't fire
      },
    ]);

    expect(svc.getStatus().isRunning).toBe(false);

    await svc.start();
    expect(svc.getStatus().isRunning).toBe(true);

    svc.stop();
    expect(svc.getStatus().isRunning).toBe(false);
  });

  // 1f. Duplicate start() is a no-op --------------------------------------------
  it("calling start() twice does not double-schedule timers", async () => {
    prisma.currency.findMany.mockResolvedValue([]);
    const warnSpy = jest.spyOn(console, "warn").mockImplementation(() => {});

    const svc = new PriceAggregatorService([
      {
        granularity: "HOUR",
        windowMs: 3_600_000,
        lookbackCount: 0,
        cronIntervalMs: 999_999_999,
      },
    ]);

    await svc.start();
    await svc.start(); // second call

    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("Already running"),
    );

    svc.stop();
    warnSpy.mockRestore();
  });
});

// ── 2. GET /api/v1/analytics/ohlc HTTP integration tests ─────────────────────

describe("GET /api/v1/analytics/ohlc", () => {
  const originalEnv = { ...process.env };
  let app: typeof import("../src/app").default;
  const API_KEY = "test-api-key-208";

  beforeAll(async () => {
    process.env.API_KEY = API_KEY;
    process.env.ADMIN_API_KEY = "test-admin";
    process.env.REDIS_URL = "";

    const prisma = (await import("../src/lib/prisma")).default as any;
    prisma.relayer.findFirst.mockResolvedValue(null);

    ({ default: app } = await import("../src/app"));
  });

  afterAll(() => {
    for (const key of Object.keys(process.env)) {
      if (!(key in originalEnv)) delete process.env[key];
    }
    Object.assign(process.env, originalEnv);
  });

  beforeEach(async () => {
    jest.clearAllMocks();
    // Relayer auth mock must always return null to fall back to env API_KEY
    const prisma = ((await import("../src/lib/prisma")) as any).default;
    prisma.relayer.findFirst.mockResolvedValue(null);
    prisma.apiKey.findUnique.mockResolvedValue({
      id: "test-id",
      label: "test-label",
      scopes: ["read", "write"],
      isActive: true,
      expiresAt: null,
    });
  });

  const headers = () => ({ "x-api-key": API_KEY });

  // 2a. Missing currency ---------------------------------------------------------
  it("returns 400 when `currency` query param is missing", async () => {
    await withServer(app, async (port) => {
      const res = await requestJson(
        port,
        "/api/v1/analytics/ohlc?granularity=HOUR",
        { headers: headers() },
      );
      assert.strictEqual(res.statusCode, 400);
      assert.strictEqual(res.body.success, false);
      assert.ok(res.body.error.toLowerCase().includes("currency"));
    });
  });

  // 2b. Missing granularity ------------------------------------------------------
  it("returns 400 when `granularity` query param is missing", async () => {
    await withServer(app, async (port) => {
      const res = await requestJson(
        port,
        "/api/v1/analytics/ohlc?currency=NGN",
        { headers: headers() },
      );
      assert.strictEqual(res.statusCode, 400);
      assert.strictEqual(res.body.success, false);
      assert.ok(res.body.error.toLowerCase().includes("granularity"));
    });
  });

  // 2c. Invalid granularity ------------------------------------------------------
  it("returns 400 for an unrecognised granularity value", async () => {
    await withServer(app, async (port) => {
      const res = await requestJson(
        port,
        "/api/v1/analytics/ohlc?currency=NGN&granularity=WEEK",
        { headers: headers() },
      );
      assert.strictEqual(res.statusCode, 400);
      assert.strictEqual(res.body.success, false);
      assert.ok(res.body.error.includes("WEEK"));
    });
  });

  // 2d. from >= to ---------------------------------------------------------------
  it("returns 400 when `from` is not before `to`", async () => {
    const from = "2024-01-10T00:00:00Z";
    const to = "2024-01-09T00:00:00Z"; // to < from

    await withServer(app, async (port) => {
      const res = await requestJson(
        port,
        `/api/v1/analytics/ohlc?currency=NGN&granularity=HOUR&from=${from}&to=${to}`,
        { headers: headers() },
      );
      assert.strictEqual(res.statusCode, 400);
      assert.strictEqual(res.body.success, false);
    });
  });

  // 2e. Invalid limit ------------------------------------------------------------
  it("returns 400 for a non-positive `limit`", async () => {
    await withServer(app, async (port) => {
      const res = await requestJson(
        port,
        "/api/v1/analytics/ohlc?currency=NGN&granularity=HOUR&limit=0",
        { headers: headers() },
      );
      assert.strictEqual(res.statusCode, 400);
      assert.strictEqual(res.body.success, false);
    });
  });

  // 2f. Successful response shape ------------------------------------------------
  it("returns 200 with correct candle shape when data exists", async () => {
    const prisma = ((await import("../src/lib/prisma")) as any).default;

    const openTime = new Date("2024-06-01T10:00:00Z");
    const closeTime = new Date("2024-06-01T11:00:00Z");

    prisma.ohlcCandle.findMany.mockResolvedValue([
      {
        openTime,
        closeTime,
        open: { toString: () => "1500.00" },
        high: { toString: () => "1550.00" },
        low: { toString: () => "1490.00" },
        close: { toString: () => "1530.00" },
        count: 42,
      },
    ]);

    await withServer(app, async (port) => {
      const res = await requestJson(
        port,
        "/api/v1/analytics/ohlc?currency=NGN&granularity=HOUR",
        { headers: headers() },
      );

      assert.strictEqual(res.statusCode, 200);
      assert.strictEqual(res.body.success, true);

      const { data } = res.body;
      assert.strictEqual(data.currency, "NGN");
      assert.strictEqual(data.granularity, "HOUR");
      assert.strictEqual(data.count, 1);

      const candle = data.candles[0];
      assert.strictEqual(candle.open, "1500.00");
      assert.strictEqual(candle.high, "1550.00");
      assert.strictEqual(candle.low, "1490.00");
      assert.strictEqual(candle.close, "1530.00");
      assert.strictEqual(candle.count, 42);
      assert.ok(candle.openTime);
      assert.ok(candle.closeTime);
    });
  });

  // 2g. Empty result -------------------------------------------------------------
  it("returns 200 with empty candles array when no data exists", async () => {
    const prisma = ((await import("../src/lib/prisma")) as any).default;
    prisma.ohlcCandle.findMany.mockResolvedValue([]);

    await withServer(app, async (port) => {
      const res = await requestJson(
        port,
        "/api/v1/analytics/ohlc?currency=GHS&granularity=DAY",
        { headers: headers() },
      );

      assert.strictEqual(res.statusCode, 200);
      assert.strictEqual(res.body.success, true);
      assert.strictEqual(res.body.data.count, 0);
      assert.deepStrictEqual(res.body.data.candles, []);
    });
  });

  // 2h. limit capped at 500 -----------------------------------------------------
  it("caps limit at MAX_LIMIT (500) even when a larger value is passed", async () => {
    const prisma = ((await import("../src/lib/prisma")) as any).default;
    prisma.ohlcCandle.findMany.mockResolvedValue([]);

    await withServer(app, async (port) => {
      const res = await requestJson(
        port,
        "/api/v1/analytics/ohlc?currency=KES&granularity=MINUTE&limit=9999",
        { headers: headers() },
      );

      // Should still succeed and Prisma should have been called with take <= 500
      assert.strictEqual(res.statusCode, 200);
      const call = prisma.ohlcCandle.findMany.mock.calls[0][0];
      assert.ok(call.take <= 500);
    });
  });
});

// ── 3. GET /api/v1/analytics/status ──────────────────────────────────────────

describe("GET /api/v1/analytics/status", () => {
  const API_KEY = "test-api-key-status";
  let app: typeof import("../src/app").default;

  beforeAll(async () => {
    process.env.API_KEY = API_KEY;
    process.env.ADMIN_API_KEY = "test-admin-status";
    process.env.REDIS_URL = "";

    const prisma = (await import("../src/lib/prisma")).default as any;
    prisma.relayer.findFirst.mockResolvedValue(null);

    ({ default: app } = await import("../src/app"));
  });

  it("returns worker status with isRunning = false before start()", async () => {
    await withServer(app, async (port) => {
      const res = await requestJson(port, "/api/v1/analytics/status", {
        headers: { "x-api-key": API_KEY },
      });

      assert.strictEqual(res.statusCode, 200);
      assert.strictEqual(res.body.success, true);
      assert.ok("isRunning" in res.body.data);
      // Worker is not started by app.ts import (only index.ts starts it)
      assert.strictEqual(res.body.data.isRunning, false);
    });
  });
});
