import { getRedisClient } from "../lib/redis";
import { broadcastToSessions } from "../lib/socket";
import { createFetcherLogger } from "../utils/logger";
import {
  evaluateCancellationRatio,
  pruneWindow,
  resolveCancellationThresholds,
  type CancellationRatioEvaluation,
  type CancellationRatioThresholds,
  type OrderFlowEvent,
  type OrderFlowEventType,
} from "../logic/orderCancellationAnomaly";
import {
  AlertSeverity,
  AlertType,
  NotificationService,
} from "./notificationService";

export interface OrderFlowInput {
  /** Explicit account identifier (public key, API key, or IP). */
  identifier?: string;
  publicKey?: string;
  ip?: string;
  type: OrderFlowEventType;
  timestamp?: number;
}

export interface OrderCancellationAnomaly {
  identifier: string;
  placed: number;
  cancelled: number;
  cancellationRatio: number;
  windowMs: number;
  detectedAt: string;
  throttledUntil: string;
  ip?: string;
  publicKey?: string;
}

/**
 * Minimal Redis surface the detector needs. Kept structural so tests can pass
 * a fake without mocking the whole redis module.
 */
export interface OrderAnomalyRedisClient {
  isOpen: boolean;
  get(key: string): Promise<string | null>;
  set(key: string, value: string, options?: { PX?: number }): Promise<unknown>;
}

export interface OrderBookImbalanceDetectorOptions {
  notifications?: Pick<NotificationService, "sendAlert">;
  thresholds?: Partial<CancellationRatioThresholds>;
  /** How long a flagged account stays throttled. Defaults to 5 minutes. */
  throttleMs?: number;
  now?: () => number;
  maxTrackedIdentifiers?: number;
  /** Resolves the shared Redis client; defaults to the process-wide client. */
  redisProvider?: () => OrderAnomalyRedisClient | null;
}

export const DEFAULT_ORDER_ANOMALY_THROTTLE_MS = 5 * 60 * 1000;
const DEFAULT_MAX_TRACKED_IDENTIFIERS = 10_000;

/**
 * Resolves the account identifier used to bucket order flow. Public keys take
 * precedence over IP addresses so NATed traders are not throttled together.
 */
export function resolveOrderFlowIdentifier(input: {
  identifier?: string | null | undefined;
  publicKey?: string | null | undefined;
  ip?: string | null | undefined;
}): string | null {
  const candidate = (
    input.identifier ??
    input.publicKey ??
    input.ip ??
    ""
  ).trim();
  return candidate.length > 0 ? candidate : null;
}

/**
 * Order Book Imbalance & Front-Running Anomaly Detector (Issue #975).
 *
 * Tracks order placements and cancellations per account inside a rolling
 * window, flags accounts whose cancellation ratio R_cancel exceeds the
 * configured threshold, and temporarily throttles them by writing an expiring
 * marker to Redis (shared across instances) with an in-memory fallback.
 */
export class OrderBookImbalanceDetector {
  private readonly logger = createFetcherLogger("OrderBookImbalanceDetector");
  private readonly notifications: Pick<NotificationService, "sendAlert">;
  private readonly thresholds: CancellationRatioThresholds;
  private readonly throttleMs: number;
  private readonly now: () => number;
  private readonly maxTrackedIdentifiers: number;
  private readonly redisProvider: () => OrderAnomalyRedisClient | null;
  private readonly windows = new Map<string, OrderFlowEvent[]>();
  private readonly throttledUntil = new Map<string, number>();

  constructor(options: OrderBookImbalanceDetectorOptions = {}) {
    this.notifications = options.notifications ?? new NotificationService();
    this.thresholds = {
      ...resolveCancellationThresholds(),
      ...options.thresholds,
    };
    this.throttleMs = options.throttleMs ?? DEFAULT_ORDER_ANOMALY_THROTTLE_MS;
    this.now = options.now ?? (() => Date.now());
    this.maxTrackedIdentifiers =
      options.maxTrackedIdentifiers ?? DEFAULT_MAX_TRACKED_IDENTIFIERS;
    this.redisProvider =
      options.redisProvider ??
      (() => getRedisClient() as unknown as OrderAnomalyRedisClient | null);
  }

  /**
   * Records a single placement or cancellation. Returns the anomaly (and
   * throttles the account) when the rolling ratio crosses the threshold,
   * otherwise returns null.
   */
  public async recordOrderFlow(
    input: OrderFlowInput,
  ): Promise<OrderCancellationAnomaly | null> {
    const identifier = resolveOrderFlowIdentifier(input);
    if (!identifier) {
      throw new Error(
        "Order flow event requires an identifier, public key, or IP address",
      );
    }
    if (input.type !== "placed" && input.type !== "cancelled") {
      throw new Error(
        `Unsupported order flow event type: ${String(input.type)}`,
      );
    }

    const timestamp = input.timestamp ?? this.now();
    const event: OrderFlowEvent = {
      identifier,
      type: input.type,
      timestamp,
      ...(input.ip ? { ip: input.ip } : {}),
      ...(input.publicKey ? { publicKey: input.publicKey } : {}),
    };

    const window = pruneWindow(
      [...(this.windows.get(identifier) ?? []), event],
      timestamp,
      this.thresholds.windowMs,
    );
    this.windows.set(identifier, window);
    this.enforceCapacity();

    const evaluation = evaluateCancellationRatio(
      identifier,
      window,
      timestamp,
      this.thresholds,
    );
    if (!evaluation.flagged) {
      return null;
    }

    const alreadyThrottled = await this.isThrottled(identifier, timestamp);
    const anomaly = await this.applyThrottle(
      identifier,
      evaluation,
      input,
      timestamp,
    );
    if (!alreadyThrottled) {
      await this.dispatch(anomaly);
    }
    return anomaly;
  }

  /** Read-only rolling cancellation stats for an account. */
  public getCancellationStats(
    identifier: string,
    at: number = this.now(),
  ): CancellationRatioEvaluation {
    const window = pruneWindow(
      this.windows.get(identifier) ?? [],
      at,
      this.thresholds.windowMs,
    );
    return evaluateCancellationRatio(identifier, window, at, this.thresholds);
  }

  /** True while the account is throttled, checked against Redis then memory. */
  public async isThrottled(
    identifier: string,
    at: number = this.now(),
  ): Promise<boolean> {
    const memoryUntil = this.throttledUntil.get(identifier);
    if (memoryUntil !== undefined) {
      if (memoryUntil > at) return true;
      this.throttledUntil.delete(identifier);
    }

    const redis = this.redisProvider();
    if (redis?.isOpen) {
      try {
        const raw = await redis.get(this.getThrottleKey(identifier));
        if (!raw) return false;
        const parsed = JSON.parse(raw) as { throttledUntil?: string };
        const until = parsed.throttledUntil
          ? Date.parse(parsed.throttledUntil)
          : Number.NaN;
        return Number.isFinite(until) && until > at;
      } catch (error) {
        this.logger.warn("Failed to read order anomaly throttle state", {
          identifier,
          error,
        });
      }
    }

    return false;
  }

  /** Clears tracked windows and in-memory throttle state (Redis is untouched). */
  public reset(identifier?: string): void {
    if (identifier) {
      this.windows.delete(identifier);
      this.throttledUntil.delete(identifier);
      return;
    }
    this.windows.clear();
    this.throttledUntil.clear();
  }

  private async applyThrottle(
    identifier: string,
    evaluation: CancellationRatioEvaluation,
    input: OrderFlowInput,
    at: number,
  ): Promise<OrderCancellationAnomaly> {
    const throttledUntil = at + this.throttleMs;
    this.throttledUntil.set(identifier, throttledUntil);

    const anomaly: OrderCancellationAnomaly = {
      identifier,
      placed: evaluation.placed,
      cancelled: evaluation.cancelled,
      cancellationRatio: evaluation.cancellationRatio,
      windowMs: evaluation.windowMs,
      detectedAt: new Date(at).toISOString(),
      throttledUntil: new Date(throttledUntil).toISOString(),
      ...(input.ip ? { ip: input.ip } : {}),
      ...(input.publicKey ? { publicKey: input.publicKey } : {}),
    };

    const redis = this.redisProvider();
    if (redis?.isOpen) {
      try {
        await redis.set(
          this.getThrottleKey(identifier),
          JSON.stringify(anomaly),
          {
            PX: this.throttleMs,
          },
        );
      } catch (error) {
        this.logger.warn("Failed to persist order anomaly throttle", {
          identifier,
          error,
        });
      }
    }

    return anomaly;
  }

  private async dispatch(anomaly: OrderCancellationAnomaly): Promise<void> {
    const ratioPercent = (anomaly.cancellationRatio * 100).toFixed(1);
    this.logger.warn("Order cancellation anomaly detected; account throttled", {
      identifier: anomaly.identifier,
      placed: anomaly.placed,
      cancelled: anomaly.cancelled,
      cancellationRatio: anomaly.cancellationRatio,
    });

    broadcastToSessions("order.cancellation_anomaly", anomaly);

    try {
      await this.notifications.sendAlert({
        type: AlertType.ORDER_CANCELLATION_ANOMALY,
        severity: AlertSeverity.HIGH,
        title: "Order cancellation anomaly detected",
        message: `Account ${anomaly.identifier} cancelled ${ratioPercent}% of its orders in the last ${Math.round(anomaly.windowMs / 1000)}s and has been throttled until ${anomaly.throttledUntil}.`,
        details: { ...anomaly },
        timestamp: new Date(anomaly.detectedAt),
        service: "order-book-imbalance-detector",
      });
    } catch (error) {
      this.logger.error("Failed to dispatch order anomaly alert", {
        identifier: anomaly.identifier,
        error,
      });
    }
  }

  private getThrottleKey(identifier: string): string {
    return `order-anomaly:throttle:${identifier}`;
  }

  private enforceCapacity(): void {
    if (this.windows.size <= this.maxTrackedIdentifiers) return;
    const oldest = this.windows.keys().next().value as string | undefined;
    if (oldest !== undefined) {
      this.windows.delete(oldest);
    }
  }
}

export const orderBookImbalanceDetector = new OrderBookImbalanceDetector();
export default orderBookImbalanceDetector;
