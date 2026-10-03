import { decode, encode } from "@msgpack/msgpack";

/**
 * Market stream event kinds multiplexed over a single WebSocket endpoint.
 */
export type MarketStreamEventType =
  | "ticker"
  | "trade"
  | "orderbook"
  | "heartbeat"
  | "error";

export interface MarketStreamEvent<T = unknown> {
  /** Event discriminator for the client to route without decoding the payload. */
  type: MarketStreamEventType;
  /** Trading pair, normalized as `BASE-QUOTE` (e.g. `USDC-XLM`). */
  pair: string;
  /** Unix epoch milliseconds when the update was emitted. */
  timestamp: number;
  /** Event-specific body. */
  data: T;
}

/**
 * Serialize any JS value into MsgPack bytes.
 *
 * This is the wire format used by the combined market-stream endpoint.
 * MsgPack keeps per-socket memory low compared to JSON because it
 * avoids repeated key strings and uses a compact binary encoding.
 */
export function pack<T = unknown>(data: T): Uint8Array {
  return encode(data);
}

/**
 * Deserialize MsgPack bytes back into a JS value.
 *
 * Accepts a `string` for convenience when a text frame is received
 * (e.g. from a test harness or a non-binary transport), and `Uint8Array`
 * or `Buffer` for the normal binary WebSocket frame path.
 */
export function unpack<T = unknown>(payload: Uint8Array | Buffer | string): T {
  if (typeof payload === "string") {
    return decode(Buffer.from(payload, "utf-8")) as T;
  }

  return decode(payload) as T;
}

/**
 * Pack a market-stream event into a single MsgPack frame.
 */
export function packMarketEvent<T = unknown>(
  event: MarketStreamEvent<T>,
): Uint8Array {
  return pack(event);
}

/**
 * Unpack a market-stream event frame received from the combined endpoint.
 */
export function unpackMarketEvent<T = unknown>(
  payload: Uint8Array | Buffer | string,
): MarketStreamEvent<T> {
  return unpack<MarketStreamEvent<T>>(payload);
}
