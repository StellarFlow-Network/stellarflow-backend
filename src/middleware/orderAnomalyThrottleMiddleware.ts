import { Request, Response, NextFunction } from "express";
import { apiErrorPayload } from "../lib/apiError.js";
import {
  orderBookImbalanceDetector,
  resolveOrderFlowIdentifier,
  type OrderBookImbalanceDetector,
} from "../services/orderBookImbalanceDetector";

/**
 * Best-effort account identifier for an incoming request. Mirrors the
 * identifier precedence used by the detector: authenticated user id, then
 * Stellar public key (header or relayer), then the resolved client IP.
 */
export function resolveRequestOrderFlowIdentifier(req: Request): string | null {
  const rawHeader = req.headers["x-stellar-publickey"];
  const headerPublicKey = Array.isArray(rawHeader) ? rawHeader[0] : rawHeader;
  const userId = (req as { user?: { id?: string } }).user?.id;
  const ip = req.ip ?? req.socket.remoteAddress ?? undefined;

  return resolveOrderFlowIdentifier({
    identifier: userId,
    publicKey: headerPublicKey ?? req.relayer?.publicKey ?? undefined,
    ip,
  });
}

/**
 * Rejects requests from accounts currently throttled by the
 * {@link orderBookImbalanceDetector}. Mount this ahead of order submission
 * endpoints so flagged front-running accounts cannot continue placing orders.
 */
export function orderAnomalyThrottleMiddleware(
  detector: Pick<
    OrderBookImbalanceDetector,
    "isThrottled"
  > = orderBookImbalanceDetector,
) {
  return async (
    req: Request,
    res: Response,
    next: NextFunction,
  ): Promise<void> => {
    try {
      const identifier = resolveRequestOrderFlowIdentifier(req);
      if (!identifier) {
        next();
        return;
      }

      if (await detector.isThrottled(identifier)) {
        res
          .status(429)
          .json(
            apiErrorPayload(
              "ORDER_ANOMALY_THROTTLED",
              "This account is temporarily throttled due to suspicious order cancellation activity.",
            ),
          );
        return;
      }

      next();
    } catch (error) {
      console.error("[OrderAnomalyThrottle] Unexpected error:", error);
      next();
    }
  };
}
