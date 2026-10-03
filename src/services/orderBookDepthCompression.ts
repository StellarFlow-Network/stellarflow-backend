import { performance } from "node:perf_hooks";

import { decode, encode } from "@msgpack/msgpack";

import type { DepthLevel, OrderDepth } from "./orderDepthAggregatorService";

/**
 * Order Book Depth Map Compression Module (Issue #1000)
 *
 * Redis keeps one depth document per trading pair. JSON repeats every field
 * name for every price level (~76 bytes per level), which dominates the
 * footprint of `orders:book:<market>:depth:cache`. This module serialises the
 * same document with MessagePack (`@msgpack/msgpack`, already a dependency) in
 * a columnar shape - the repeated keys disappear and numeric levels are stored
 * as native numbers - and frames the result with a small header:
 *
 * ```
 * offset  size  field
 * 0       4     magic "SFD1"
 * 4       1     format version (1)
 * 5       1     reserved flags (0)
 * 6       4     payload byte length, uint32 BE
 * 10      n     MessagePack payload
 * ```
 *
 * The payload is a five element MessagePack array
 * `[market, tickSize, generatedAt, bids, asks]`, where each side is a four
 * element columnar array `[prices, volumes, cumulativeVolumes, orderCounts]`.
 *
 * Decimal strings stay lossless: a value is stored as a MessagePack number when
 * it is already canonical (`String(Number(value)) === value`, which is what
 * `decimalString()` in the aggregator produces) and is kept verbatim otherwise,
 * so padded ("1.50"), plain decimal ("0.000000000001") and exponential ("1e21")
 * inputs survive the round trip unchanged.
 *
 * `measureCompressionRatio()` and `benchmarkOrderDepthCodec()` measure the two
 * acceptance criteria of issue #1000 (far fewer bytes than JSON, encode and
 * decode overhead below 0.5ms) against real depth maps.
 */

/** Magic prefix ("StellarFlow Depth", format 1) on every compressed payload. */
export const ORDER_BOOK_DEPTH_MAGIC = "SFD1";

/** Version of the payload layout described above. */
export const ORDER_BOOK_DEPTH_FORMAT_VERSION = 1;

/** Byte saving vs JSON that issue #1000 requires (60%). */
export const ORDER_BOOK_DEPTH_MIN_REDUCTION = 0.6;

/** Encode/decode overhead ceiling that issue #1000 requires (0.5ms). */
export const ORDER_BOOK_DEPTH_LATENCY_BUDGET_MS = 0.5;

const HEADER_SIZE = ORDER_BOOK_DEPTH_MAGIC.length + 1 + 1 + 4;
const HEADER_OFFSET_VERSION = ORDER_BOOK_DEPTH_MAGIC.length;
const HEADER_OFFSET_PAYLOAD_LENGTH = ORDER_BOOK_DEPTH_MAGIC.length + 2;

const SIDE_COLUMN_COUNT = 4;
const PAYLOAD_FIELD_COUNT = 5;

const DEFAULT_BENCHMARK_ITERATIONS = 100;
const DEFAULT_BENCHMARK_WARMUP_ITERATIONS = 20;

/** Raised when a depth map cannot be encoded, or a payload cannot be decoded. */
export class OrderBookDepthCodecError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OrderBookDepthCodecError";
  }
}

/** Byte sizes of a depth map before and after compression. */
export interface CompressionMeasurement {
  /** Byte length of the equivalent `JSON.stringify(depth)` baseline. */
  jsonBytes: number;
  /** Byte length of the compressed payload written to Redis. */
  encodedBytes: number;
  /** `encodedBytes / jsonBytes`; lower is better. */
  ratio: number;
  /** `1 - ratio` expressed as a percentage. */
  reductionPercent: number;
  /** True when the reduction clears {@link ORDER_BOOK_DEPTH_MIN_REDUCTION}. */
  meetsTarget: boolean;
}

/** Latency distribution of one codec direction, in milliseconds. */
export interface CodecLatencyStats {
  /** Number of timed samples. */
  samples: number;
  avgMs: number;
  minMs: number;
  p50Ms: number;
  p95Ms: number;
  maxMs: number;
}

/** Result of {@link benchmarkOrderDepthCodec}. */
export interface OrderBookDepthCodecBenchmark {
  /** Timed iterations per direction. */
  iterations: number;
  encode: CodecLatencyStats;
  decode: CodecLatencyStats;
  compression: CompressionMeasurement;
  /** Overhead ceiling the benchmark was compared against. */
  latencyBudgetMs: number;
  /** True when encode and decode averages *and* p95 stay inside the budget. */
  withinLatencyBudget: boolean;
}

/** Options for {@link benchmarkOrderDepthCodec}. */
export interface OrderBookDepthCodecBenchmarkOptions {
  /** Timed iterations per direction. Defaults to 100. */
  iterations?: number;
  /** Untimed iterations used to warm up the JIT. Defaults to 20. */
  warmupIterations?: number;
  /** Overhead ceiling in milliseconds. Defaults to 0.5. */
  latencyBudgetMs?: number;
}

type EncodedDecimal = number | string;

type EncodedSide = [
  EncodedDecimal[],
  EncodedDecimal[],
  EncodedDecimal[],
  number[],
];

/* ------------------------------- encoding -------------------------------- */

function toEncodableText(value: unknown, field: string): string {
  if (typeof value === "string" && value.length > 0) return value;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  throw new OrderBookDepthCodecError(
    `${field} must be a non-empty decimal string`,
  );
}

function toOrderCount(value: unknown, field: string): number {
  if (typeof value === "number" && Number.isInteger(value) && value >= 0) {
    return value;
  }
  throw new OrderBookDepthCodecError(`${field} must be a non-negative integer`);
}

/**
 * Canonical decimals round trip through a double, so they are stored as
 * MessagePack numbers; anything else is kept as a string to stay lossless.
 */
function encodeDecimal(value: string): EncodedDecimal {
  const numeric = Number(value);
  return Number.isFinite(numeric) && String(numeric) === value
    ? numeric
    : value;
}

function encodeSide(levels: DepthLevel[], side: string): EncodedSide {
  if (!Array.isArray(levels)) {
    throw new OrderBookDepthCodecError(
      `${side} must be an array of depth levels`,
    );
  }

  const prices: EncodedDecimal[] = [];
  const volumes: EncodedDecimal[] = [];
  const cumulativeVolumes: EncodedDecimal[] = [];
  const orderCounts: number[] = [];

  levels.forEach((level: DepthLevel | undefined, index: number) => {
    const path = `${side}[${index}]`;
    prices.push(
      encodeDecimal(toEncodableText(level?.price, `${path}.price`)),
    );
    volumes.push(
      encodeDecimal(toEncodableText(level?.volume, `${path}.volume`)),
    );
    cumulativeVolumes.push(
      encodeDecimal(
        toEncodableText(level?.cumulativeVolume, `${path}.cumulativeVolume`),
      ),
    );
    orderCounts.push(toOrderCount(level?.orderCount, `${path}.orderCount`));
  });

  return [prices, volumes, cumulativeVolumes, orderCounts];
}

function encodePayload(depth: OrderDepth): unknown[] {
  if (!depth || typeof depth !== "object") {
    throw new OrderBookDepthCodecError(
      "depth must be an order book depth object",
    );
  }

  const market = toEncodableText(depth.market, "market");
  const tickSize = toEncodableText(depth.tickSize, "tickSize");
  const generatedAt = toEncodableText(depth.generatedAt, "generatedAt");

  return [
    market,
    tickSize,
    generatedAt,
    encodeSide(depth.bids, "bids"),
    encodeSide(depth.asks, "asks"),
  ];
}

/**
 * Serialise an order book depth map into a compact binary payload that is safe
 * to store in Redis as-is (Redis accepts `Buffer` values).
 */
export function encodeOrderDepth(depth: OrderDepth): Buffer {
  const payload = Buffer.from(encode(encodePayload(depth)));

  const header = Buffer.alloc(HEADER_SIZE);
  header.write(
    ORDER_BOOK_DEPTH_MAGIC,
    0,
    ORDER_BOOK_DEPTH_MAGIC.length,
    "latin1",
  );
  header.writeUInt8(ORDER_BOOK_DEPTH_FORMAT_VERSION, HEADER_OFFSET_VERSION);
  header.writeUInt8(0, HEADER_OFFSET_VERSION + 1);
  header.writeUInt32BE(payload.length, HEADER_OFFSET_PAYLOAD_LENGTH);

  return Buffer.concat([header, payload], HEADER_SIZE + payload.length);
}

/* ------------------------------- decoding -------------------------------- */

function asBuffer(payload: Buffer | Uint8Array): Buffer {
  return Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
}

function decodeDecimal(value: unknown, field: string): string {
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new OrderBookDepthCodecError(`${field} is not a finite number`);
    }
    return String(value);
  }
  if (typeof value === "string" && value.length > 0) return value;
  throw new OrderBookDepthCodecError(
    `${field} must be a number or a decimal string`,
  );
}

function decodeOrderCount(value: unknown, field: string): number {
  if (typeof value === "number" && Number.isInteger(value) && value >= 0) {
    return value;
  }
  throw new OrderBookDepthCodecError(`${field} must be a non-negative integer`);
}

function decodeText(value: unknown, field: string): string {
  if (typeof value === "string" && value.length > 0) return value;
  throw new OrderBookDepthCodecError(`${field} must be a non-empty string`);
}

function asColumn(value: unknown, field: string): unknown[] {
  if (!Array.isArray(value)) {
    throw new OrderBookDepthCodecError(`${field} must be an array`);
  }
  return value as unknown[];
}

function decodeSide(value: unknown, side: string): DepthLevel[] {
  if (!Array.isArray(value) || value.length !== SIDE_COLUMN_COUNT) {
    throw new OrderBookDepthCodecError(
      `${side} must be a MessagePack array of ${SIDE_COLUMN_COUNT} columns`,
    );
  }

  const fields = value as unknown[];
  const prices = asColumn(fields[0], `${side}.prices`);
  const volumes = asColumn(fields[1], `${side}.volumes`);
  const cumulativeVolumes = asColumn(fields[2], `${side}.cumulativeVolumes`);
  const orderCounts = asColumn(fields[3], `${side}.orderCounts`);

  if (
    volumes.length !== prices.length ||
    cumulativeVolumes.length !== prices.length ||
    orderCounts.length !== prices.length
  ) {
    throw new OrderBookDepthCodecError(
      `${side} columns must all have the same length`,
    );
  }

  const levels: DepthLevel[] = [];
  for (let index = 0; index < prices.length; index++) {
    const path = `${side}[${index}]`;
    levels.push({
      price: decodeDecimal(prices[index], `${path}.price`),
      volume: decodeDecimal(volumes[index], `${path}.volume`),
      cumulativeVolume: decodeDecimal(
        cumulativeVolumes[index],
        `${path}.cumulativeVolume`,
      ),
      orderCount: decodeOrderCount(orderCounts[index], `${path}.orderCount`),
    });
  }

  return levels;
}

/**
 * Rebuild an order book depth map from a payload produced by
 * {@link encodeOrderDepth}.
 *
 * @throws {OrderBookDepthCodecError} when the payload is not a compressed depth
 * map, is truncated, declares an unknown version, or its body is not valid
 * MessagePack.
 */
export function decodeOrderDepth(payload: Buffer | Uint8Array): OrderDepth {
  const buffer = asBuffer(payload);

  if (buffer.length < HEADER_SIZE) {
    throw new OrderBookDepthCodecError(
      `compressed depth payload is truncated: expected at least ${HEADER_SIZE} header bytes, received ${buffer.length}`,
    );
  }

  const magic = buffer.toString("latin1", 0, ORDER_BOOK_DEPTH_MAGIC.length);
  if (magic !== ORDER_BOOK_DEPTH_MAGIC) {
    throw new OrderBookDepthCodecError(
      `compressed depth payload has an invalid magic prefix: expected "${ORDER_BOOK_DEPTH_MAGIC}", received "${magic}"`,
    );
  }

  const version = buffer.readUInt8(HEADER_OFFSET_VERSION);
  if (version !== ORDER_BOOK_DEPTH_FORMAT_VERSION) {
    throw new OrderBookDepthCodecError(
      `unsupported compressed depth payload version: ${version}`,
    );
  }

  const declaredLength = buffer.readUInt32BE(HEADER_OFFSET_PAYLOAD_LENGTH);
  const receivedLength = buffer.length - HEADER_SIZE;
  if (declaredLength !== receivedLength) {
    throw new OrderBookDepthCodecError(
      `compressed depth payload is truncated or corrupted: header declares ${declaredLength} payload bytes, received ${receivedLength}`,
    );
  }

  let decoded: unknown;
  try {
    decoded = decode(buffer.subarray(HEADER_SIZE));
  } catch (error) {
    throw new OrderBookDepthCodecError(
      `compressed depth payload is not valid MessagePack: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }

  if (!Array.isArray(decoded) || decoded.length !== PAYLOAD_FIELD_COUNT) {
    throw new OrderBookDepthCodecError(
      `compressed depth payload must decode to a ${PAYLOAD_FIELD_COUNT} element MessagePack array`,
    );
  }

  const fields = decoded as unknown[];
  const market = decodeText(fields[0], "market");
  const tickSize = decodeText(fields[1], "tickSize");
  const generatedAt = decodeText(fields[2], "generatedAt");

  return {
    market,
    tickSize,
    bids: decodeSide(fields[3], "bids"),
    asks: decodeSide(fields[4], "asks"),
    generatedAt,
  };
}

/**
 * Cheap check used by the cache read path to tell compressed payloads apart
 * from JSON written before this module shipped. Accepts either bytes or the
 * string form returned by a client without RESP blob mapping.
 */
export function isCompressedOrderDepth(
  payload: Buffer | Uint8Array | string | null | undefined,
): boolean {
  if (payload === null || payload === undefined) return false;

  const prefix =
    typeof payload === "string"
      ? payload.slice(0, ORDER_BOOK_DEPTH_MAGIC.length)
      : payload
          .subarray(0, ORDER_BOOK_DEPTH_MAGIC.length)
          .toString("latin1");

  return prefix === ORDER_BOOK_DEPTH_MAGIC;
}

/* ------------------------------ measurement ------------------------------ */

function percentile(sortedSamples: number[], quantile: number): number {
  if (sortedSamples.length === 0) return 0;
  const index = Math.min(
    sortedSamples.length - 1,
    Math.max(0, Math.ceil(quantile * sortedSamples.length) - 1),
  );
  return sortedSamples[index] ?? 0;
}

function summarizeLatency(samples: number[]): CodecLatencyStats {
  const sorted = [...samples].sort((left, right) => left - right);
  const total = sorted.reduce((sum, sample) => sum + sample, 0);

  return {
    samples: sorted.length,
    avgMs: sorted.length === 0 ? 0 : total / sorted.length,
    minMs: sorted[0] ?? 0,
    p50Ms: percentile(sorted, 0.5),
    p95Ms: percentile(sorted, 0.95),
    maxMs: sorted[sorted.length - 1] ?? 0,
  };
}

function normalizeIterations(
  value: number | undefined,
  fallback: number,
): number {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value < 1) {
    throw new OrderBookDepthCodecError(
      "benchmark iterations must be a positive integer",
    );
  }
  return value;
}

/**
 * Compare the compressed payload against the JSON payload that used to be
 * written to Redis. Nothing here is hard coded: both sizes are measured from
 * the depth map that is passed in.
 */
export function measureCompressionRatio(
  depth: OrderDepth,
): CompressionMeasurement {
  const jsonBytes = Buffer.byteLength(JSON.stringify(depth), "utf8");
  const encodedBytes = encodeOrderDepth(depth).length;
  const ratio = jsonBytes === 0 ? 0 : encodedBytes / jsonBytes;
  const reductionPercent = (1 - ratio) * 100;

  return {
    jsonBytes,
    encodedBytes,
    ratio,
    reductionPercent,
    meetsTarget: reductionPercent >= ORDER_BOOK_DEPTH_MIN_REDUCTION * 100,
  };
}

/**
 * Measure encode/decode overhead with `performance.now()` over a warm run.
 *
 * The reported average and p95 for both directions are compared against
 * `latencyBudgetMs` to produce {@link OrderBookDepthCodecBenchmark.withinLatencyBudget}.
 */
export function benchmarkOrderDepthCodec(
  depth: OrderDepth,
  options: OrderBookDepthCodecBenchmarkOptions = {},
): OrderBookDepthCodecBenchmark {
  const iterations = normalizeIterations(
    options.iterations,
    DEFAULT_BENCHMARK_ITERATIONS,
  );
  const warmupIterations = normalizeIterations(
    options.warmupIterations,
    DEFAULT_BENCHMARK_WARMUP_ITERATIONS,
  );
  const latencyBudgetMs =
    options.latencyBudgetMs ?? ORDER_BOOK_DEPTH_LATENCY_BUDGET_MS;

  for (let index = 0; index < warmupIterations; index++) {
    decodeOrderDepth(encodeOrderDepth(depth));
  }

  const encodeSamples: number[] = [];
  const decodeSamples: number[] = [];

  for (let index = 0; index < iterations; index++) {
    const encodeStartedAt = performance.now();
    const payload = encodeOrderDepth(depth);
    encodeSamples.push(performance.now() - encodeStartedAt);

    const decodeStartedAt = performance.now();
    decodeOrderDepth(payload);
    decodeSamples.push(performance.now() - decodeStartedAt);
  }

  const encode = summarizeLatency(encodeSamples);
  const decode = summarizeLatency(decodeSamples);

  return {
    iterations,
    encode,
    decode,
    compression: measureCompressionRatio(depth),
    latencyBudgetMs,
    withinLatencyBudget:
      encode.avgMs <= latencyBudgetMs &&
      decode.avgMs <= latencyBudgetMs &&
      encode.p95Ms <= latencyBudgetMs &&
      decode.p95Ms <= latencyBudgetMs,
  };
}
