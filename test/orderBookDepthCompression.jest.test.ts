import { encode as encodeMessagePack } from "@msgpack/msgpack";

import {
  ORDER_BOOK_DEPTH_FORMAT_VERSION,
  ORDER_BOOK_DEPTH_LATENCY_BUDGET_MS,
  ORDER_BOOK_DEPTH_MAGIC,
  ORDER_BOOK_DEPTH_MIN_REDUCTION,
  OrderBookDepthCodecError,
  benchmarkOrderDepthCodec,
  decodeOrderDepth,
  encodeOrderDepth,
  isCompressedOrderDepth,
  measureCompressionRatio,
} from "../src/services/orderBookDepthCompression";
import { orderDepthAggregatorService } from "../src/services/orderDepthAggregatorService";
import type {
  DepthLevel,
  OrderDepth,
} from "../src/services/orderDepthAggregatorService";

// In-memory fake Redis, mirroring test/orderBookSnapshotEngine.jest.test.ts
const fakeStore = new Map<string, string | Buffer>();
let sideMembers: { bids: string[]; asks: string[] } = { bids: [], asks: [] };

const fakeBinaryReader = {
  // The RESP blob mapping hands back raw bytes for every cache entry.
  get: jest.fn(async (key: string): Promise<Buffer | null> => {
    const value = fakeStore.get(key) ?? null;
    if (value === null) return null;
    return Buffer.isBuffer(value) ? value : Buffer.from(value, "utf8");
  }),
};

const fakeRedis = {
  isReady: true,
  isOpen: true,
  set: jest.fn(async (key: string, value: string | Buffer) => {
    fakeStore.set(key, value);
    return "OK";
  }),
  withTypeMapping: jest.fn(() => fakeBinaryReader),
  zRange: jest.fn(async (key: string) =>
    key.endsWith(":bids") ? sideMembers.bids : sideMembers.asks,
  ),
};

jest.mock("../src/lib/redis", () => ({
  getRedisClient: jest.fn(() => fakeRedis),
}));

jest.mock("../src/utils/logger", () => ({
  logger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
}));

const DEPTH_CACHE_KEY = "orders:book:XLM/USDC:depth:cache";
const HEADER_SIZE = ORDER_BOOK_DEPTH_MAGIC.length + 6;

/** A realistic book: 25 levels per side is the synchronizer's max depth. */
function buildDepth(levels: number): OrderDepth {
  const bids: DepthLevel[] = [];
  const asks: DepthLevel[] = [];
  let cumulativeBid = 0;
  let cumulativeAsk = 0;

  for (let index = 0; index < levels; index++) {
    const bidPrice = Number((0.1284 - index * 0.0001).toFixed(12));
    const bidVolume = Number((1250.5 + index * 37.25).toFixed(12));
    cumulativeBid += bidVolume;
    bids.push({
      price: String(bidPrice),
      volume: String(bidVolume),
      cumulativeVolume: String(Number(cumulativeBid.toFixed(12))),
      orderCount: 1 + (index % 7),
    });

    const askPrice = Number((0.1286 + index * 0.0001).toFixed(12));
    const askVolume = Number((980.75 + index * 21.5).toFixed(12));
    cumulativeAsk += askVolume;
    asks.push({
      price: String(askPrice),
      volume: String(askVolume),
      cumulativeVolume: String(Number(cumulativeAsk.toFixed(12))),
      orderCount: 1 + (index % 5),
    });
  }

  return {
    market: "XLM/USDC",
    tickSize: "0.0001",
    bids,
    asks,
    generatedAt: "2026-09-28T16:20:00.000Z",
  };
}

/** Same shape, but every level reuses the supplied decimal strings. */
function buildDepthFromValues(values: string[]): OrderDepth {
  return {
    market: "XLM/USDC",
    tickSize: "0.0001",
    bids: values.map((value, index) => ({
      price: value,
      volume: value,
      cumulativeVolume: value,
      orderCount: index,
    })),
    asks: [],
    generatedAt: "2026-09-28T16:20:00.000Z",
  };
}

/** Wrap an arbitrary MessagePack body in the SFD1 header. */
function frame(body: Buffer): Buffer {
  const header = Buffer.alloc(HEADER_SIZE);
  header.write(
    ORDER_BOOK_DEPTH_MAGIC,
    0,
    ORDER_BOOK_DEPTH_MAGIC.length,
    "latin1",
  );
  header.writeUInt8(ORDER_BOOK_DEPTH_FORMAT_VERSION, 4);
  header.writeUInt32BE(body.length, 6);
  return Buffer.concat([header, body]);
}

describe("orderBookDepthCompression", () => {
  describe("round trip", () => {
    it("should frame a depth map as an SFD1 payload", () => {
      const encoded = encodeOrderDepth(buildDepth(25));

      expect(Buffer.isBuffer(encoded)).toBe(true);
      expect(encoded.subarray(0, 4).toString("latin1")).toBe(
        ORDER_BOOK_DEPTH_MAGIC,
      );
      expect(encoded.readUInt8(4)).toBe(ORDER_BOOK_DEPTH_FORMAT_VERSION);
      expect(encoded.readUInt32BE(6)).toBe(encoded.length - HEADER_SIZE);
    });

    it("should round-trip a depth map losslessly", () => {
      const depth = buildDepth(25);

      expect(decodeOrderDepth(encodeOrderDepth(depth))).toEqual(depth);
    });

    it("should round-trip an empty book", () => {
      const depth: OrderDepth = {
        market: "XLM/USDC",
        tickSize: "0.0001",
        bids: [],
        asks: [],
        generatedAt: "2026-09-28T16:20:00.000Z",
      };

      expect(decodeOrderDepth(encodeOrderDepth(depth))).toEqual(depth);
    });

    it("should preserve precision boundaries exactly", () => {
      const boundaries = [
        "0.1",
        "1e-12",
        "0.000000000001",
        "0.30000000000000004",
        "1.50",
        "0.10",
        "1e21",
        "1e+21",
        "9007199254740991",
        "1234567.123456789012",
      ];

      const depth = buildDepthFromValues(boundaries);

      expect(decodeOrderDepth(encodeOrderDepth(depth))).toEqual(depth);
    });
  });

  describe("malformed payloads", () => {
    it("should reject a buffer shorter than the header", () => {
      expect(() => decodeOrderDepth(Buffer.alloc(0))).toThrow(
        OrderBookDepthCodecError,
      );
      expect(() => decodeOrderDepth(Buffer.alloc(HEADER_SIZE - 1))).toThrow(
        /truncated/,
      );
    });

    it("should reject a payload with a foreign magic prefix", () => {
      const encoded = Buffer.from(encodeOrderDepth(buildDepth(2)));
      encoded.write("XXXX", 0, 4, "latin1");

      expect(() => decodeOrderDepth(encoded)).toThrow(OrderBookDepthCodecError);
      expect(() => decodeOrderDepth(encoded)).toThrow(/magic prefix/);
    });

    it("should reject an unsupported format version", () => {
      const encoded = Buffer.from(encodeOrderDepth(buildDepth(2)));
      encoded.writeUInt8(99, 4);

      expect(() => decodeOrderDepth(encoded)).toThrow(/version/);
    });

    it("should reject a truncated payload", () => {
      const encoded = encodeOrderDepth(buildDepth(5));
      const truncated = encoded.subarray(0, encoded.length - 8);

      expect(() => decodeOrderDepth(truncated)).toThrow(
        OrderBookDepthCodecError,
      );
      expect(() => decodeOrderDepth(truncated)).toThrow(
        /truncated or corrupted/,
      );
    });

    it("should reject a body that is not MessagePack", () => {
      // 0xc1 is the one byte MessagePack never assigns.
      const corrupted = frame(Buffer.from([0xc1]));

      expect(() => decodeOrderDepth(corrupted)).toThrow(
        /not valid MessagePack/,
      );
    });

    it("should reject a body that is not a depth map", () => {
      const wrongShape = frame(
        Buffer.from(
          encodeMessagePack([
            "XLM/USDC",
            "0.0001",
            "2026-09-28T16:20:00.000Z",
            "not-a-side",
            [],
          ]),
        ),
      );

      expect(() => decodeOrderDepth(wrongShape)).toThrow(
        /bids must be a MessagePack array of 4 columns/,
      );
    });

    it("should reject mismatched column lengths", () => {
      const mismatched = frame(
        Buffer.from(
          encodeMessagePack([
            "XLM/USDC",
            "0.0001",
            "2026-09-28T16:20:00.000Z",
            [[1], [], [], []],
            [[], [], [], []],
          ]),
        ),
      );

      expect(() => decodeOrderDepth(mismatched)).toThrow(
        /columns must all have the same length/,
      );
    });

    it("should only recognise its own payloads", () => {
      const encoded = encodeOrderDepth(buildDepth(2));

      expect(isCompressedOrderDepth(encoded)).toBe(true);
      expect(isCompressedOrderDepth(JSON.stringify(buildDepth(2)))).toBe(false);
      expect(isCompressedOrderDepth(Buffer.alloc(2))).toBe(false);
      expect(isCompressedOrderDepth("")).toBe(false);
      expect(isCompressedOrderDepth(null)).toBe(false);
      expect(isCompressedOrderDepth(undefined)).toBe(false);
    });
  });

  describe("measurement", () => {
    it("should beat the 60% reduction target against JSON", () => {
      const depth = buildDepth(25);
      const measurement = measureCompressionRatio(depth);

      expect(measurement.jsonBytes).toBe(
        Buffer.byteLength(JSON.stringify(depth), "utf8"),
      );
      expect(measurement.encodedBytes).toBe(encodeOrderDepth(depth).length);
      expect(measurement.encodedBytes).toBeLessThan(measurement.jsonBytes);
      expect(measurement.reductionPercent).toBeGreaterThan(
        ORDER_BOOK_DEPTH_MIN_REDUCTION * 100,
      );
      expect(measurement.meetsTarget).toBe(true);
    });

    it("should measure overhead inside the 0.5ms budget", () => {
      const benchmark = benchmarkOrderDepthCodec(buildDepth(25), {
        iterations: 100,
        warmupIterations: 20,
      });

      expect(benchmark.iterations).toBe(100);
      expect(benchmark.encode.samples).toBe(100);
      expect(benchmark.decode.samples).toBe(100);
      expect(benchmark.latencyBudgetMs).toBe(
        ORDER_BOOK_DEPTH_LATENCY_BUDGET_MS,
      );
      expect(benchmark.encode.avgMs).toBeGreaterThan(0);
      expect(benchmark.decode.avgMs).toBeGreaterThan(0);
      expect(benchmark.compression.reductionPercent).toBeGreaterThan(
        ORDER_BOOK_DEPTH_MIN_REDUCTION * 100,
      );
      expect(benchmark.withinLatencyBudget).toBe(true);
    });

    it("should reject an invalid benchmark iteration count", () => {
      expect(() =>
        benchmarkOrderDepthCodec(buildDepth(1), { iterations: 0 }),
      ).toThrow(OrderBookDepthCodecError);
    });
  });

  describe("order depth cache integration", () => {
    beforeEach(() => {
      fakeStore.clear();
      sideMembers = { bids: [], asks: [] };
      fakeRedis.isReady = true;
      jest.clearAllMocks();
    });

    it("should write compressed payloads and read them back", async () => {
      sideMembers = {
        bids: [JSON.stringify({ price: "0.1284", volume: "1000" })],
        asks: [JSON.stringify({ price: "0.1286", volume: "500" })],
      };

      await orderDepthAggregatorService.updateDepth("XLM/USDC", "0.0001");

      const stored = fakeStore.get(DEPTH_CACHE_KEY);
      expect(Buffer.isBuffer(stored)).toBe(true);
      expect(isCompressedOrderDepth(stored as Buffer)).toBe(true);

      const cached = await orderDepthAggregatorService.getCachedDepth(
        "XLM/USDC",
      );
      expect(cached).not.toBeNull();
      expect(decodeOrderDepth(stored as Buffer)).toEqual(cached);
      expect(cached?.bids).toEqual([
        {
          price: "0.1284",
          volume: "1000",
          cumulativeVolume: "1000",
          orderCount: 1,
        },
      ]);
      expect(cached?.asks).toEqual([
        {
          price: "0.1286",
          volume: "500",
          cumulativeVolume: "500",
          orderCount: 1,
        },
      ]);
    });

    it("should store fewer bytes than the JSON it replaces", async () => {
      sideMembers = {
        bids: Array.from({ length: 25 }, (_, index) =>
          JSON.stringify({
            price: String(Number((0.1284 - index * 0.0001).toFixed(12))),
            volume: String(Number((1250.5 + index * 37.25).toFixed(12))),
          }),
        ),
        asks: [],
      };

      const depth = await orderDepthAggregatorService.getDepth(
        "XLM/USDC",
        "0.0001",
      );
      await orderDepthAggregatorService.updateDepth("XLM/USDC", "0.0001");

      const stored = fakeStore.get(DEPTH_CACHE_KEY) as Buffer;
      expect(stored.length).toBeLessThan(
        Buffer.byteLength(JSON.stringify(depth), "utf8"),
      );
    });

    it("should still read legacy JSON entries", async () => {
      const legacy = buildDepth(3);
      fakeStore.set(DEPTH_CACHE_KEY, JSON.stringify(legacy));

      const cached = await orderDepthAggregatorService.getCachedDepth(
        "XLM/USDC",
      );

      expect(cached).toEqual(legacy);
    });

    it("should discard corrupted entries instead of throwing", async () => {
      const encoded = encodeOrderDepth(buildDepth(2));
      fakeStore.set(DEPTH_CACHE_KEY, encoded.subarray(0, encoded.length - 4));

      const cached = await orderDepthAggregatorService.getCachedDepth(
        "XLM/USDC",
      );

      expect(cached).toBeNull();
    });

    it("should return null when Redis is not ready", async () => {
      fakeStore.set(DEPTH_CACHE_KEY, encodeOrderDepth(buildDepth(2)));
      fakeRedis.isReady = false;

      expect(
        await orderDepthAggregatorService.getCachedDepth("XLM/USDC"),
      ).toBeNull();
    });
  });
});
