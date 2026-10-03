/**
 * src/services/eventBus/types.ts
 *
 * Shared contracts for the internal event bus observability stack
 * (Issue #1055).
 *
 * The stack is split into small, individually testable pieces:
 *
 *   queueDepthCollector  — reads depths from Redis and the Celery/RabbitMQ broker
 *   eventBusMetrics      — publishes those depths as Prometheus samples
 *   queueBackpressureBot — decides when a backlog is an incident and who to tell
 *   workerAutoscaler     — turns queue depth into a worker replica count
 *
 * Everything below is transport- and vendor-agnostic so the modules can be
 * unit tested without a live Redis, RabbitMQ, Slack or PagerDuty instance.
 */

/** Backing store a queue lives in. */
export type QueueTransport =
  "redis-list" | "redis-stream" | "redis-set" | "redis-pubsub" | "amqp";

/** Severity ladder shared by the collector, the bot and the metrics. */
export type BackpressureLevel = "ok" | "warning" | "critical";

/**
 * A queue the collector should watch.
 *
 * `pool` groups queues that are drained by the same set of worker containers
 * (for example every queue routed to the `celery-webhook` worker pool), which
 * is the unit the autoscaler scales.
 */
export interface QueueDescriptor {
  /** Stable identifier used as the Prometheus `queue` label. */
  name: string;
  /** Worker pool that drains this queue. */
  pool: string;
  transport: QueueTransport;
  /** Redis key or AMQP queue name. Required for every transport but pub/sub. */
  key?: string;
  /** Pub/sub channel name — only used when `transport` is `redis-pubsub`. */
  channel?: string;
  /** Per-queue override of the global backpressure threshold. */
  warningThreshold?: number;
  /** Per-queue override of the global critical threshold. */
  criticalThreshold?: number;
  /**
   * In-process backlog reader. Pub/sub is fire-and-forget in Redis, so the only
   * real "pending" count for a channel is whatever the local ingestion buffer
   * (lock-free ring buffer / worker-thread queue) is holding. Registering that
   * reader is what makes channel depths meaningful.
   */
  getLocalDepth?: () => number;
}

/** One observation of a single queue. */
export interface QueueDepthSample {
  name: string;
  pool: string;
  transport: QueueTransport;
  /** Messages waiting for a worker (backlog). */
  pending: number;
  /** Delivered-but-unacknowledged messages, when the transport exposes it. */
  unacked: number | null;
  /** Live consumer/worker count attached to the queue. */
  consumers: number | null;
  /** Age of the oldest waiting message in seconds, when known. */
  oldestPendingAgeSeconds: number | null;
  /** Whether the queue is "accepting work" — a 0-consumer pub/sub channel is dead. */
  acceptingMessages: boolean;
  observedAt: string;
  /** Set when the probe failed; `pending` is then reported as -1. */
  error?: string;
}

/** Result of reading one queue, including local-only fallbacks. */
export interface QueueDepthReading {
  pending: number;
  unacked: number | null;
  consumers: number | null;
  oldestPendingAgeSeconds?: number | null;
}

/** Minimal Redis surface the collector needs — trivially fakeable in tests. */
export interface RedisDepthReader {
  listLength(key: string): Promise<number>;
  setLength(key: string): Promise<number>;
  streamLength(key: string): Promise<number>;
  channelSubscribers(channel: string): Promise<number>;
  oldestEntryAgeSeconds?(key: string): Promise<number | null>;
}

/** Minimal AMQP surface the collector needs. */
export interface AmqpDepthReader {
  checkQueue(queue: string): Promise<{
    messageCount: number;
    consumerCount: number;
  }>;
  /**
   * Optional enrichment from the RabbitMQ management API, which is the only
   * way to observe unacknowledged messages. Implementations own the vhost.
   */
  managementQueueStats?(
    queue: string,
  ): Promise<{ messagesReady: number; messagesUnacknowledged: number } | null>;
}

/** A backpressure incident the bot decided to raise. */
export interface BackpressureAlert {
  /** Queue name, or `event-bus-total` for the aggregate scope. */
  scope: string;
  pool: string | null;
  /** `ok` only ever appears on a `resolve` alert. */
  level: BackpressureLevel;
  pending: number;
  threshold: number;
  criticalThreshold: number;
  /** Percentage of the threshold exceeded, rounded to one decimal. */
  overshootPercent: number;
  /** `trigger` on first notification, `reminder` afterwards, `resolve` on recovery. */
  kind: "trigger" | "reminder" | "resolve";
  observedAt: string;
  /** Per-queue breakdown, sorted by backlog descending. */
  queues: Array<{
    name: string;
    pool: string;
    transport: QueueTransport;
    pending: number;
    consumers: number | null;
    unacked: number | null;
  }>;
  /** Transport-level probe failures observed during the same cycle. */
  probeErrors: string[];
  /** Worker pool replicas the autoscaler wants for this alert's scope. */
  desiredReplicas: number | null;
}

/** What the bot did for one queue (or the aggregate scope) in a cycle. */
export interface BackpressureEvaluation {
  alerts: BackpressureAlert[];
  /** Per-scope level after evaluation, for dashboards and tests. */
  levels: Record<string, BackpressureLevel>;
  totalPending: number;
  criticalScopes: string[];
}

/** Notifier seam — production wires this to Slack + PagerDuty. */
export interface AlertDispatcher {
  trigger(alert: BackpressureAlert): Promise<void>;
  resolve(alert: BackpressureAlert): Promise<void>;
}

/** Scale provider seam — production wires this to Docker/K8s/webhooks. */
export interface ScaleProvider {
  readonly name: string;
  getReplicaCount(pool: string): Promise<number | null>;
  setReplicaCount(pool: string, replicas: number): Promise<void>;
}

export type ScaleAction = "none" | "scale_up" | "scale_down";

/** Outcome of one autoscaler evaluation. */
export interface ScaleDecision {
  pool: string;
  action: ScaleAction;
  from: number | null;
  to: number;
  reason: string;
  pending: number;
  /** Set when the decision was clamped or blocked by a guard rail. */
  limitedBy: string | null;
  decidedAt: string;
}

/** Full autoscaler verdict for all pools in a cycle. */
export interface AutoscalerEvaluation {
  decisions: ScaleDecision[];
  /** Desired replica count per pool, whether or not a scale action was taken. */
  desired: Record<string, number>;
  enabled: boolean;
}
