/**
 * src/services/eventBus/config.ts
 *
 * Environment-driven configuration for the event bus metrics / backpressure
 * alert bot (Issue #1055).
 *
 * Everything is optional: with no environment variables set the collector still
 * watches the Celery queues that ship in `app/celery_app.py`, the Redis DLQ and
 * the in-process ingestion buffer, and every outbound integration degrades to
 * a no-op instead of throwing. That keeps local development and CI free of
 * broker/webhook dependencies.
 */

import type { QueueDescriptor, QueueTransport } from "./types";

/** Backlog (in messages) that promotes a queue to a `warning`. */
export const DEFAULT_BACKPRESSURE_THRESHOLD = 1_000;

/** Multiplier of the warning threshold that promotes a queue to `critical`. */
export const DEFAULT_CRITICAL_MULTIPLIER = 5;

/** Fraction of the threshold a queue must fall back under to auto-resolve. */
export const DEFAULT_RECOVERY_RATIO = 0.5;

/** Celery queues declared in `app/celery_app.py` plus the implicit default. */
export const DEFAULT_CELERY_QUEUES = [
  "celery",
  "webhook.retry",
  "webhook.dead",
  "index-shielded-notes",
] as const;

/** Pool that owns the Celery queues declared in `app/celery_app.py`. */
export const DEFAULT_CELERY_POOL = "celery-webhook";

/** Redis list used by the dead-letter queue (`app/queue/dlq.py`). */
export const DEFAULT_DLQ_KEY = "stellarflow:dlq";

export interface AlertBotConfig {
  /** Minimum backlog before an alert is raised. Issue #1055 mandates 1,000. */
  threshold: number;
  /** Backlog at which the incident is escalated to PagerDuty. */
  criticalThreshold: number;
  /** Minimum gap between two notifications for the same scope. */
  cooldownMs: number;
  /** Scope used to watch the aggregate backlog of the whole event bus. */
  totalScopeName: string;
  /** Also alert on the summed backlog of every watched queue. */
  alertOnTotal: boolean;
  /** Backlog ratio below which a scope auto-resolves. */
  recoveryRatio: number;
  /** Emit `resolve` notifications when a scope returns below the threshold. */
  resolveOnRecovery: boolean;
}

export interface AutoscalerConfig {
  enabled: boolean;
  /** Floor for worker replicas. Never scaled below this. */
  minReplicas: number;
  /** Ceiling for worker replicas. Never scaled above this. */
  maxReplicas: number;
  /** Target number of pending messages a single worker instance should absorb. */
  targetMessagesPerReplica: number;
  /** Largest change allowed in a single cycle, in replicas. */
  maxScaleStep: number;
  /** Minimum gap between two scale actions on the same pool. */
  cooldownMs: number;
  /**
   * How long a pool must stay under the scale-down threshold before replicas
   * are removed. Prevents flapping when workers are draining a backlog.
   */
  scaleDownStabilizationMs: number;
  /** Backlog at or above which the pool should be considered fully drained. */
  scaleDownThreshold: number;
  /** Pools to manage. Empty means "every pool seen by the collector". */
  pools: string[];
}

export interface EventBusConfig {
  enabled: boolean;
  /** Collection / evaluation interval. */
  pollIntervalMs: number;
  /** Per-probe timeout so one hung broker cannot stall a cycle. */
  probeTimeoutMs: number;
  /** Number of samples retained for the admin endpoint. */
  historySize: number;
  redisUrl: string | null;
  amqpUrl: string | null;
  /** Optional RabbitMQ management API, used for unacked counts. */
  rabbitmqManagementUrl: string | null;
  rabbitmqVhost: string;
  alert: AlertBotConfig;
  autoscaler: AutoscalerConfig;
  /** Static queue catalogue. Additional queues can be registered at runtime. */
  queues: QueueDescriptor[];
  /** PagerDuty Events API v2 routing key. */
  pagerdutyRoutingKey: string | null;
  /** Slack incoming-webhook URL used for non-critical notifications. */
  slackWebhookUrl: string | null;
}

type Env = Record<string, string | undefined>;

function readNumber(
  env: Env,
  key: string,
  fallback: number,
  { min = 0, max = Number.MAX_SAFE_INTEGER } = {},
): number {
  const raw = env[key];
  if (raw === undefined || raw.trim() === "") return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < min || parsed > max) return fallback;
  return Math.floor(parsed);
}

function readBoolean(env: Env, key: string, fallback: boolean): boolean {
  const raw = env[key];
  if (raw === undefined || raw.trim() === "") return fallback;
  const normalized = raw.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return fallback;
}

function readList(env: Env, key: string, fallback: string[]): string[] {
  const raw = env[key];
  if (raw === undefined || raw.trim() === "") return fallback;
  const items = raw
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
  return items.length > 0 ? items : fallback;
}

function readString(env: Env, key: string): string | null {
  const raw = env[key];
  if (raw === undefined) return null;
  const trimmed = raw.trim();
  return trimmed === "" ? null : trimmed;
}

/**
 * Build the queue catalogue.
 *
 * Precedence: explicit `EVENT_BUS_QUEUES` (comma-separated `name:transport:key`
 * triples) replaces the default catalogue entirely; otherwise the Celery and
 * Redis defaults are used and any extra queues are appended.
 */
export function buildQueueDescriptors(
  env: Env = process.env,
): QueueDescriptor[] {
  const explicit = readList(env, "EVENT_BUS_QUEUES", []);
  if (explicit.length > 0) {
    return explicit
      .map(parseQueueSpec)
      .filter((q): q is QueueDescriptor => q !== null);
  }

  const celeryQueues = readList(env, "CELERY_MONITORED_QUEUES", [
    ...DEFAULT_CELERY_QUEUES,
  ]);
  const pool = readString(env, "CELERY_WORKER_POOL") ?? DEFAULT_CELERY_POOL;
  const descriptors: QueueDescriptor[] = celeryQueues.map((queue) => ({
    name: `celery:${queue}`,
    pool,
    transport: "amqp" as QueueTransport,
    key: queue,
  }));

  const dlqKey = readString(env, "DLQ_REDIS_KEY") ?? DEFAULT_DLQ_KEY;
  descriptors.push({
    name: "redis:dlq",
    pool: "ingestion-dlq",
    transport: "redis-list",
    key: dlqKey,
  });

  const dlqWorkerKey = readString(env, "REDIS_DLQ_WORKER_QUEUE_KEY");
  if (dlqWorkerKey) {
    descriptors.push({
      name: "redis:dlq-worker",
      pool: "ingestion-dlq",
      transport: "redis-stream",
      key: dlqWorkerKey,
    });
  }

  const streamKeys = readList(env, "REDIS_MONITORED_STREAM_KEYS", []);
  for (const key of streamKeys) {
    descriptors.push({
      name: `redis:stream:${key}`,
      pool: "redis-streams",
      transport: "redis-stream",
      key,
    });
  }

  const listKeys = readList(env, "REDIS_MONITORED_LIST_KEYS", []);
  for (const key of listKeys) {
    descriptors.push({
      name: `redis:list:${key}`,
      pool: "redis-lists",
      transport: "redis-list",
      key,
    });
  }

  const channels = readList(env, "REDIS_MONITORED_PUBSUB_CHANNELS", []);
  for (const channel of channels) {
    descriptors.push({
      name: `redis:pubsub:${channel}`,
      pool: "redis-pubsub",
      transport: "redis-pubsub",
      channel,
    });
  }

  return descriptors;
}

/**
 * Parse a `name:transport:key` triple. Returns `null` for malformed entries so
 * a typo in configuration is skipped instead of breaking startup.
 */
function parseQueueSpec(spec: string): QueueDescriptor | null {
  const [name, transport, key] = spec.split(":");
  if (!name || !transport) return null;
  const pool = readString(process.env, "EVENT_BUS_WORKER_POOL") ?? "default";
  if (transport === "redis-pubsub") {
    return {
      name,
      pool,
      transport: "redis-pubsub",
      channel: key || name,
    };
  }
  const known: QueueTransport[] = [
    "redis-list",
    "redis-stream",
    "redis-set",
    "amqp",
  ];
  if (!known.includes(transport as QueueTransport)) return null;
  return {
    name,
    pool,
    transport: transport as QueueTransport,
    key: key || name,
  };
}

/** Load the full event bus configuration from the environment. */
export function loadEventBusConfig(env: Env = process.env): EventBusConfig {
  const threshold = readNumber(
    env,
    "EVENT_BUS_BACKPRESSURE_THRESHOLD",
    DEFAULT_BACKPRESSURE_THRESHOLD,
    {
      min: 1,
    },
  );
  const criticalThreshold = readNumber(
    env,
    "EVENT_BUS_CRITICAL_THRESHOLD",
    Math.max(threshold, threshold * DEFAULT_CRITICAL_MULTIPLIER),
    { min: 1 },
  );
  const minReplicas = readNumber(env, "EVENT_BUS_AUTOSCALE_MIN_REPLICAS", 1, {
    min: 0,
    max: 10_000,
  });
  const maxReplicas = Math.max(
    minReplicas,
    readNumber(env, "EVENT_BUS_AUTOSCALE_MAX_REPLICAS", 20, {
      min: 0,
      max: 10_000,
    }),
  );

  return {
    enabled: readBoolean(env, "EVENT_BUS_MONITORING_ENABLED", true),
    pollIntervalMs: readNumber(env, "EVENT_BUS_POLL_INTERVAL_MS", 15_000, {
      min: 1_000,
    }),
    probeTimeoutMs: readNumber(env, "EVENT_BUS_PROBE_TIMEOUT_MS", 5_000, {
      min: 100,
    }),
    historySize: readNumber(env, "EVENT_BUS_HISTORY_SIZE", 120, {
      min: 1,
      max: 10_000,
    }),
    redisUrl:
      readString(env, "EVENT_BUS_REDIS_URL") ?? readString(env, "REDIS_URL"),
    amqpUrl:
      readString(env, "EVENT_BUS_AMQP_URL") ??
      readString(env, "CELERY_BROKER_URL"),
    rabbitmqManagementUrl: readString(env, "RABBITMQ_MANAGEMENT_URL"),
    rabbitmqVhost: readString(env, "RABBITMQ_VHOST") ?? "/",
    alert: {
      threshold,
      criticalThreshold: Math.max(threshold, criticalThreshold),
      cooldownMs: readNumber(
        env,
        "EVENT_BUS_ALERT_COOLDOWN_MS",
        15 * 60 * 1000,
        {
          min: 0,
        },
      ),
      totalScopeName:
        readString(env, "EVENT_BUS_TOTAL_SCOPE_NAME") ?? "event-bus-total",
      alertOnTotal: readBoolean(env, "EVENT_BUS_ALERT_ON_TOTAL", true),
      resolveOnRecovery: readBoolean(env, "EVENT_BUS_RESOLVE_ALERTS", true),
      recoveryRatio: readNumber(
        env,
        "EVENT_BUS_RECOVERY_RATIO",
        DEFAULT_RECOVERY_RATIO,
        {
          min: 0.01,
          max: 0.99,
        },
      ),
    },
    autoscaler: {
      enabled: readBoolean(env, "EVENT_BUS_AUTOSCALE_ENABLED", false),
      minReplicas,
      maxReplicas,
      targetMessagesPerReplica: readNumber(
        env,
        "EVENT_BUS_AUTOSCALE_TARGET_MSGS_PER_REPLICA",
        250,
        { min: 1 },
      ),
      maxScaleStep: readNumber(env, "EVENT_BUS_AUTOSCALE_MAX_STEP", 5, {
        min: 1,
        max: 1_000,
      }),
      cooldownMs: readNumber(
        env,
        "EVENT_BUS_AUTOSCALE_COOLDOWN_MS",
        5 * 60 * 1000,
        {
          min: 0,
        },
      ),
      scaleDownStabilizationMs: readNumber(
        env,
        "EVENT_BUS_AUTOSCALE_STABILIZATION_MS",
        10 * 60 * 1000,
        { min: 0 },
      ),
      scaleDownThreshold: readNumber(
        env,
        "EVENT_BUS_AUTOSCALE_DOWN_THRESHOLD",
        Math.floor(threshold / 4),
        { min: 0 },
      ),
      pools: readList(env, "EVENT_BUS_AUTOSCALE_POOLS", []),
    },
    queues: buildQueueDescriptors(env),
    pagerdutyRoutingKey: readString(env, "PAGERDUTY_ROUTING_KEY"),
    slackWebhookUrl: readString(env, "SLACK_WEBHOOK_URL"),
  };
}
