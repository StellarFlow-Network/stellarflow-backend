import {
  packOrderBookDepth,
  unpackOrderBookDepth,
  benchmarkBinaryDepthSerializer,
  BINARY_DEPTH_MAGIC,
  BINARY_DEPTH_VERSION,
  TARGET_PAYLOAD_SIZE_BYTES,
  TARGET_SERIALIZATION_LATENCY_MS,
  BinaryOrderBookDepthInput,
} from "../src/services/binaryDepthSerializer";

describe("BinaryDepthSerializer", () => {
  const sampleInput: BinaryOrderBookDepthInput = {
    market: "XLM-USDC",
    sequence: 12345,
    isSnapshot: true,
    bids: Array.from({ length: 50 }, (_, i) => ({
      price: 100.0 - i * 0.05,
      amount: 1000 + i * 20,
    })),
    asks: Array.from({ length: 50 }, (_, i) => ({
      price: 100.05 + i * 0.05,
      amount: 1000 + i * 20,
    })),
  };

  test("serializes top-50 bid/ask depth levels into compact struct packed binary buffer", () => {
    const buffer = packOrderBookDepth(sampleInput);

    expect(Buffer.isBuffer(buffer)).toBe(true);
    expect(buffer.toString("ascii", 0, 4)).toBe(BINARY_DEPTH_MAGIC);
    expect(buffer.readUInt8(4)).toBe(BINARY_DEPTH_VERSION);
    expect(buffer.readUInt8(5)).toBe(50); // 50 bids
    expect(buffer.readUInt8(6)).toBe(50); // 50 asks
    expect(buffer.readUInt8(7)).toBe(1);  // isSnapshot flag
    expect(buffer.readUInt32LE(8)).toBe(12345);
  });

  test("payload size stays under 512 bytes for top-50 bid/ask depth snapshots", () => {
    const buffer = packOrderBookDepth(sampleInput);

    // Exact formula: 12 (header) + 8 (reference prices) + 50 * 4 (bids) + 50 * 4 (asks) = 420 bytes
    expect(buffer.length).toBe(420);
    expect(buffer.length).toBeLessThan(TARGET_PAYLOAD_SIZE_BYTES);
    expect(buffer.length).toBeLessThanOrEqual(512);
  });

  test("reduces binary payload size by > 75% compared to raw JSON strings", () => {
    const metrics = benchmarkBinaryDepthSerializer(sampleInput, 50);

    expect(metrics.binaryBytes).toBeLessThan(512);
    expect(metrics.reductionPercent).toBeGreaterThan(75);
    expect(metrics.meetsSizeCriteria).toBe(true);
  });

  test("binary depth serialization completes in < 0.1ms per market depth update", () => {
    const metrics = benchmarkBinaryDepthSerializer(sampleInput, 2000);

    expect(metrics.durationMs).toBeLessThan(TARGET_SERIALIZATION_LATENCY_MS);
    expect(metrics.meetsLatencyCriteria).toBe(true);
  });

  test("round-trips packed binary buffer faithfully back to order book depth levels", () => {
    const buffer = packOrderBookDepth(sampleInput);
    const unpacked = unpackOrderBookDepth(buffer);

    expect(unpacked.version).toBe(BINARY_DEPTH_VERSION);
    expect(unpacked.sequence).toBe(12345);
    expect(unpacked.isSnapshot).toBe(true);
    expect(unpacked.bids.length).toBe(50);
    expect(unpacked.asks.length).toBe(50);

    // Verify best bid and ask
    expect(unpacked.bestBid).toBeCloseTo(100.0, 2);
    expect(unpacked.bestAsk).toBeCloseTo(100.05, 2);

    // Verify first and last bids
    expect(unpacked.bids[0].price).toBeCloseTo(100.0, 2);
    expect(unpacked.bids[0].amount).toBe(1000);
    expect(unpacked.bids[49].price).toBeCloseTo(100.0 - 49 * 0.05, 2);

    // Verify first and last asks
    expect(unpacked.asks[0].price).toBeCloseTo(100.05, 2);
    expect(unpacked.asks[0].amount).toBe(1000);
    expect(unpacked.asks[49].price).toBeCloseTo(100.05 + 49 * 0.05, 2);
  });

  test("handles partial depth books gracefully (< 50 levels)", () => {
    const partialInput: BinaryOrderBookDepthInput = {
      sequence: 999,
      isSnapshot: false,
      bids: [
        { price: 0.12, amount: 500 },
        { price: 0.11, amount: 600 },
      ],
      asks: [
        { price: 0.13, amount: 450 },
      ],
    };

    const buffer = packOrderBookDepth(partialInput);
    // 20 + 2 * 4 + 1 * 4 = 32 bytes
    expect(buffer.length).toBe(32);

    const unpacked = unpackOrderBookDepth(buffer);
    expect(unpacked.bids.length).toBe(2);
    expect(unpacked.asks.length).toBe(1);
    expect(unpacked.isSnapshot).toBe(false);
  });

  test("rejects corrupt or truncated buffer during unpack", () => {
    expect(() => unpackOrderBookDepth(Buffer.from("SHORT"))).toThrow("Buffer too short");

    const invalidMagic = Buffer.alloc(32);
    invalidMagic.write("FAIL", 0, 4, "ascii");
    expect(() => unpackOrderBookDepth(invalidMagic)).toThrow("Invalid magic prefix");
  });
});
