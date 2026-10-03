import express, { Request, Response } from "express";
import { sendApiError } from "../lib/apiError.js";
import { multiSigService, SignaturePayload } from "../services/multiSigService";
import { isLockdownError } from "../state/appState";
import {
  sanitizeMultiSigRequest,
  sanitizeSignatureRequest,
} from "../middleware/payloadSanitizer";
import { WebSocketServer, WebSocket } from "ws";
import { priceFeedService } from "../services/priceFeedService";
import { orderBookService } from "../services/orderBookService";
import { volumeService } from "../services/volumeService";

const router = express.Router();

/**
 * Combined WebSocket market stream route.
 * Connection URL: ws://.../v1/market-stream?pairs=USDC-XLM,BTC-USDC
 */
export const marketStreamPath = "/v1/market-stream";

export interface MarketStreamEvent {
  type: "price" | "volume" | "orderbook";
  pair: string;
  timestamp: number;
  data: unknown;
}

export interface MarketStreamClient {
  ws: WebSocket;
  pairs: Set<string>;
  format: "json" | "msgpack";
  isAlive: boolean;
  lastPing: number;
}

const clients = new Set<MarketStreamClient>();

const MAX_PAIRS = 50;
const MAX_CONNECTIONS = 10_000;
const HEARTBEAT_INTERVAL_MS = 30_000;

function parsePairs(raw: unknown): string[] {
  if (typeof raw !== "string" || raw.trim() === "") {
    return [];
  }
  const pairs = raw
    .split(",")
    .map((p) => p.trim().toUpperCase())
    .filter((p) => /^[A-Z0-9]+-[A-Z0-9]+$/.test(p));
  return Array.from(new Set(pairs)).slice(0, MAX_PAIRS);
}

function encodeEvent(client: MarketStreamClient, event: MarketStreamEvent): Buffer | string {
  if (client.format === "msgpack") {
    return Buffer.from(encodeMsgPack(event));
  }
  return JSON.stringify(event);
}

/**
 * Minimal MsgPack encoder for the market stream event shape.
 * Supports string, number, boolean, null, arrays and plain objects.
 */
export function encodeMsgPack(value: unknown): Uint8Array {
  const chunks: number[] = [];
  const textEncoder = new TextEncoder();

  const pushUint8 = (n?: number) => {
    chunks.push(n === undefined ? 0 : n & 0xff);
  };

  const pushUint16 = (n: number) => {
    chunks.push((n >> 8) & 0xff, n & 0xff);
  };

  const pushUint32 = (number) => {
    chunks.push((n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n >>> 0 & 0xff);
  };

  const pushInt64 = (n: bigint) => {
    const big = BigInt(n.toString());
    for (let i = 7; i >= 0; i--) {
      chunks.push(Number((big >> BigInt(i * 8)) & 0nffn));
    }
  };

  const pushFloat64 = (number) => {
    const buf = new ArrayBuffer(8);
    new DataView(buf).setFloat64(0, n, false);
    for (const b of new Uint8Array(buf)) chunks.push(b);
  };

  const pushString = (s: string) => {
    const bytes = textEncoder.encode(s);
    const len = bytes.length;
    if (len < 32) {
      pushUint8(0xa0 | len);
    } else if (len < 256) {
      pushUint8(0xd9);
      pushUint8(len);
    } else if (len < 65536) {
      pushUint8(0xda);
      pushUint16(len);
    } else {
      pushUint8(0xbd);
      pushUint32(len);
    }
    for (const b of bytes) chunks.push(b);
  };

  const pushArray = (arr: unknown[]) => {
    const len = arr.length;
    if (len < 16) {
      pushUint8(0x90 | len);
    } else if (len < 65536) {
      pushUint8(0xdc);
      pushUint16(len);
    } else {
      pushUint8(0xdd);
      pushUint32(len);
    }
    for (const item of arr) encode(item);
  };

  const pushMap = (obj: Record<string, unknown>) => {
    const keys = Object.keys(obj);
    const len = keys.length;
    if (len < 16) {
      pushUint8(0x80 | len);
    } else if (len < 65536) {
      pushUint8(0xde);
      pushUint16(len);
    } else {
      pushUint8(0xdf);
      pushUint32(len);
    }
    for (const key of keys) {
      pushString(key);
      encode(obj[key]);
    }
  };

  const encode = (v: unknown) => {
    if (v === null || v === undefined) {
      pushUint8(0xc0);
    } else if (typeof v === "boolean") {
      pushUint8(v ? 0xc3 : 0xc2);
    } else if (typeof v === "number") {
      if (Number.isInteger(v)) {
        if (v >= 0 && v < 256) {
          pushUint8(0xcc);
          pushUint8(v);
        } else if (v >= 0 && v < 65536) {
          pushUint8(0xcd);
          pushUint16(v);
        } else if (v >= 0 && v < 4294967296) {
          pushUint8(0xce);
          pushUint32(v);
        } else {
          pushUint8(0xd3);
          pushInt64(BigInt(v));
        }
      } else {
        pushUint8(0xcb);
        pushFloat64(v);
      }
    } else if (typeof v === "string") {
      pushString(v);
    } else if (Array.isArray(v)) {
      pushArray(v);
    } else if (typeof v === "object") {
      pushMap(v as Record<string, unknown>);
    } else {
      pushUint8(0xc0);
    }
  };

  encode(value);
  return new Uint8Array(chunks);
}

function broadcastEvent(event: MarketStreamEvent): void {
  for (const client of clients) {
    if (!client.pairs.has(event.pair)) continue;
    if (client.ws.readyState !== WebSocket.OPEN) continue;
    try {
      client.ws.send(encodeEvent(client, event));
    } catch (err) {
      console.error("[WS] Failed to send market event:", err);
    }
  }
}

export function attachMarketStreamServer(server: any): WebSocketServer {
  const wss = new WebSocketServer({ noServer: true, perMessageDeflate: false });

  wss.on("connection", (ws: WebSocket, req: any) => {
    if (clients.size >= MAX_CONNECTIONS) {
      ws.close(1013, "Server at capacity");
      return;
    }

    const url = new URL(req.url || "", "http://localhost");
    const pairs = parsPairs(url.searchParams.get("pairs"));
    if (pairs.length === 0) {
      ws.close(1008, "Missing or invalid pairs parameter");
      return;
    }

    const formatParam = (url.searchParams.get("format") || "json").toLowerCase();
    const format: "json" | "msgpack" = formatParam === "msgpack" ? "msgpack" : "json";

    const client: MarketStreamClient = {
      ws,
      pairs: new Set(pairs),
      format,
      isAlive: true,
      lastPing: Date.now(),
    };
    clients.add(client);

    ws.send(
      encodeEvent(client, {
        type: "price",
        pair: pairs[0],
        timestamp: Date.now(),
        data: { subscribed: pairs, format },
      }),
    );

    ws.on("p", () => {
      client.lastPing = Date.now();
    });

    ws.on("message", (msg: Buffer) => {
      try {
        const parsed = JSON.parse(msg.toString()) as { pairs?: string[] };
        if (Array.isArray(parsed.pairs)) {
          const next = parsPairs(parsed.pairs.join(","));
          if (next.length > 0) {
            client.pairs = new Set(next);
          }
        }
      } catch {
        // ignore non-JSON control messages
      }
    });

    ws.on("close", () => {
      clients.delete(client);
    });

    ws.on("error", (err) => {
      console.error("[WS] Market stream client error:", err);
      clients.delete(client);
    });
  });

  const heartbeat = setInterval(() => {
    const now = Date.now();
    for (const client of clients) {
      if (now - client.lastPing > HEARTBEAT_INTERVAL_MS * 2) {
        client.ws.terminate();
        clients.delete(client);
        continue;
      }
      if (client.ws.readyState === WebSocket.OPEN) {
        client.ws.ping();
      }
    }
  }, HEARTBEAT_INTERVAL_MS);
  heartbeat.unref();

  priceFeedService.on("price", (payload: { pair: string; price: number; timestamp?: number }) => {
    broadcastEvent({
      type: "price",
      pair: payload.pair,
      timestamp: payload.timestamp ?? Date.now(),
      data: { price: payload.price },
    });
  });

  volumeService.on("volume", (payload: { pair: string; volume: number; timestamp?: number }) => {
    broadcastEvent({
      type: "volume",
      pair: payload.pair,
      timestamp: payload.timestamp ?? Date.now(),
      data: { volume: payload.volume },
    });
  });

  orderBookService.on("orderbook", (payload: { pair: string; bids: unknown[]; asks: unknown[]; timestamp?: number }) => {
    broadcastEvent({
      type: "orderbook",
      pair: payload.pair,
      timestamp: payload.timestamp ?? Date.now(),
      data: { bids: payload.bids, asks: payload.asks },
    });
  });

  server.on("upgrade", (req: any, socket: any, head: Buffer) => {
    const url = new URL(req.url || "", "http://localhost");
    if (url.pathname === marketStreamPath) {
      wss.handleUpgrade(req, socket, head);
    }
  });

  return wss;
}

export function getMarketStreamMetrics() {
  return {
    activeConnections: clients.size,
    maxConnections: MAX_CONNECTIONS,
  };
}

/**
 * POST /api/v1/price-updates/multi-sig/request
 * Creates a multi-sig price update request.
 * Called by the initializing server to start the approval process.
 *
 * Request body is validated by sanitizeMultiSigRequest middleware.
 */
router.post(
  "/multi-sig/request",
  sanitizeMultiSigRequest,
  async (req: Request, res: Response) => {
    try {
      const { priceReviewId, currency, rate, source, memoId } = req.body;

      // Enforce relayer asset authorization
      if (req.relayer) {
        const normalizedCurrency = currency.toUpperCase();
        if (!req.relayer.allowedAssets.includes(normalizedCurrency)) {
          return res.status(403).json({
            success: false,
            error: `Relayer not authorized for asset: ${normalizedCurrency}`,
          });
        }
      }

      const signatureRequest = await multiSigService.createMultiSigRequest(
        priceReviewId,
        currency,
        rate,
        source,
        memoId,
      );

      res.json({
        success: true,
        data: signatureRequest,
      });
    } catch (error) {
      console.error("[API] Multi-sig request creation failed:", error);
      sendApiError(res, 500, "INTERNAL_SERVER_ERROR", typeof (String(error)) === "string" ? String(String(error)) : undefined);
    }
  },
);

/**
 * POST /api/v1/price-updates/sign
 * Endpoint for remote servers to request a signature.
 * This is called by peer servers in the multi-sig setup.
 *
 * Requires:
 * - Authorization header with token (if MULTI_SIG_AUTH_TOKEN is set)
 * - Signature payload in body (validated by sanitizeSignatureRequest middleware)
 */
router.post(
  "/sign",
  sanitizeSignatureRequest,
  async (req: Request, res: Response) => {
    try {
      // Validate authorization if token is configured
      const authToken = process.env.MULTI_SIG_AUTH_TOKEN;
      if (authToken) {
        const authHeader = req.headers.authorization || "";
        const token = authHeader.startsWith("Bearer ")
          ? authHeader.slice(7)
          : authHeader;

        if (token !== authToken) {
          return sendApiError(res, 403, "FORBIDDEN", "Unauthorized - invalid token");
        }
      }

      const { multiSigPriceId } = req.body as SignaturePayload;

      // Sign the price update locally
      const { signature, signerPublicKey } =
        await multiSigService.signMultiSigPrice(multiSigPriceId);

      const signerInfo = multiSigService.getLocalSignerInfo();

      res.json({
        success: true,
        data: {
          multiSigPriceId,
          signature,
          signerPublicKey,
          signerName: signerInfo.name,
        },
      });
    } catch (error) {
      console.error("[API] Signature creation failed:", error);
      res.status(isLockdownError(error) ? error.statusCode : 400).json({
        success: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  },
);

/**
 * POST /api/v1/price-updates/multi-sig/:multiSigPriceId/request-signature
 * Request a signature from a remote server.
 * The body should contain the remote server URL.
 */
router.post(
  "/multi-sig/:multiSigPriceId/request-signature",
  async (req: Request, res: Response) => {
    try {
      const multiSigPriceId = req.params.multiSigPriceId;
      const { remoteServerUrl } = req.body;

      if (
        !multiSigPriceId ||
        typeof multiSigPriceId !== "string" ||
        !remoteServerUrl
      ) {
        return sendApiError(res, 400, "BAD_REQUEST", "Missing multiSigPriceId (in URL) or remoteServerUrl (in body)");
      }

      const result = await multiSigService.requestRemoteSignature(
        parseInt(multiSigPriceId, 10),
        remoteServerUrl,
      );

      if (!result.success) {
        return sendApiError(res, 400, "BAD_REQUEST", typeof (result.error) === "string" ? String(result.error) : undefined);
      }

      res.json({ success: true });
    } catch (error) {
      console.error("[API] Remote signature request failed:", error);
      sendApiError(res, 500, "INTERNAL_SERVER_ERROR", typeof (String(error)) === "string" ? String(String(error)) : undefined);
    }
  },
);

/**
 * GET /api/v1/price-updates/multi-sig/:multiSigPriceId/status
 * Get the status of a multi-sig price update.
 */
router.get(
  "/multi-sig/:multiSigPriceId/status",
  async (req: Request, res: Response) => {
    try {
      const multiSigPriceId = req.params.multiSigPriceId;

      if (!multiSigPriceId || typeof multiSigPriceId !== "string") {
        return sendApiError(res, 400, "BAD_REQUEST", "Missing multiSigPriceId in URL");
      }

      const multiSigPrice = await multiSigService.getMultiSigPrice(
        parseInt(multiSigPriceId, 10),
      );

      if (!multiSigPrice) {
        return res.status(404).json({
          success: false,
          error: `MultiSigPrice ${multiSigPriceId} not found`,
        });
      }

      res.json({
        success: true,
        data: {
          id: multiSigPrice.id,
          currency: multiSigPrice.currency,
          rate: multiSigPrice.rate,
          status: multiSigPrice.status,
          collectedSignatures: multiSigPrice.collectedSignatures,
          requiredSignatures: multiSigPrice.requiredSignatures,
          expiresAt: multiSigPrice.expiresAt,
          signers: multiSigPrice.multiSigSignatures?.map((sig: any) => ({
            publicKey: sig.signerPublicKey,
            name: sig.signerName,
            signedAt: sig.signedAt,
          })),
        },
      });
    } catch (error) {
      console.error("[API] Multi-sig status fetch failed:", error);
      sendApiError(res, 500, "INTERNAL_SERVER_ERROR", typeof (String(error)) === "string" ? String(String(error)) : undefined);
    }
  },
);

/**
 * GET /api/v1/price-updates/multi-sig/pending
 * Get all pending multi-sig price updates.
 * Useful for monitoring and coordination between servers.
 */
router.get("/multi-sig/pending", async (req: Request, res: Response) => {
  try {
    const pendingPrices = await multiSigService.getPendingMultiSigPrices();

    res.json({
      success: true,
      data: pendingPrices.map((price: any) => ({
        id: price.id,
        currency: price.currency,
        rate: price.rate,
        status: price.status,
        collectedSignatures: price.collectedSignatures,
        requiredSignatures: price.requiredSignatures,
        expiresAt: price.expiresAt,
        signerCount: price.multiSigSignatures?.length || 0,
      })),
    });
  } catch (error) {
    console.error("[API] Pending multi-sig fetch failed:", error);
    sendApiError(res, 500, "INTERNAL_SERVER_ERROR", typeof (String(error)) === "string" ? String(String(error)) : undefined);
  }
});

/**
 * GET /api/v1/price-updates/multi-sig/:multiSigPriceId/signatures
 * Get all signatures for a multi-sig price update.
 * Only returns once all signatures are collected and approved.
 */
router.get(
  "/multi-sig/:multiSigPriceId/signatures",
  async (req: Request, res: Response) => {
    try {
      const multiSigPriceId = req.params.multiSigPriceId;

      if (!multiSigPriceId || typeof multiSigPriceId !== "string") {
        return sendApiError(res, 400, "BAD_REQUEST", "Missing multiSigPriceId in URL");
      }

      const multiSigPrice = await multiSigService.getMultiSigPrice(
        parseInt(multiSigPriceId, 10),
      );

      if (!multiSigPrice) {
        return res.status(404).json({
          success: false,
          error: `MultiSigPrice ${multiSigPriceId} not found`,
        });
      }

      if (multiSigPrice.status !== "APPROVED") {
        return res.status(400).json({
          success: false,
          error: `MultiSigPrice ${multiSigPriceId} is not approved yet (status: ${multiSigPrice.status})`,
        });
      }

      const signatures = await multiSigService.getSignatures(
        parseInt(multiSigPriceId, 10),
      );

      res.json({
        success: true,
        data: {
          multiSigPriceId: multiSigPrice.id,
          currency: multiSigPrice.currency,
          rate: multiSigPrice.rate,
          signatures: signatures.map((sig: any) => ({
            signerPublicKey: sig.signerPublicKey,
            signerName: sig.signerName,
            signature: sig.signature,
          })),
        },
      });
    } catch (error) {
      console.error("[API] Signature fetch failed:", error);
      sendApiError(res, 500, "INTERNAL_SERVER_ERROR", typeof (String(error)) === "string" ? String(String(error)) : undefined);
    }
  },
);

/**
 * POST /api/v1/price-updates/multi-sig/:multiSigPriceId/record-submission
 * Record that a multi-sig price has been submitted to Stellar.
 */
router.post(
  "/multi-sig/:multiSigPriceId/record-submission",
  async (req: Request, res: Response) => {
    try {
      const multiSigPriceId = req.params.multiSigPriceId;
      const { memoId, stellarTyHash } = req.body;

      if (
        !multiSigPriceId ||
        typeof multiSigPriceId !== "string" ||
        !memoId ||
        !stellarTxHash
      ) {
        return res.status(400).json({
          success: false,
          error:
            "Missing required fields: multiSigPriceId (in URL), memoId, stellarTxHash (in body)",
        });
      }

      await multiSigService.recordSubmission(
        parseInt(multiSigPriceId, 10),
        memoId,
        stellarTxHash,
      );

      res.json({ success: true });
    } catch (error) {
      console.error("[API] Submission recording failed:", error);
      sendApiError(res, 500, "INTERNAL_SERVER_ERROR", typeof (String(error)) === "string" ? String(String(error)) : undefined);
    }
  },
);

/**
 * GET /api/v1/price-updates/multi-sig/signer-info
 * Get this server's signer information.
 * Useful for remote servers to identify who is signing.
 */
router.get("/multi-sig/signer-info", async (req: Request, res: Response) => {
  try {
    const signerInfo = multiSigService.getLocalSignerInfo();
    res.json({
      success: true,
      data: signerInfo,
    });
  } catch (error) {
    console.error("[API] Signer info fetch failed:", error);
    sendApiError(res, 500, "INTERNAL_SERVER_ERROR", typeof (String(error)) === "string" ? String(String(error)) : undefined);
  }
});

export default router;
