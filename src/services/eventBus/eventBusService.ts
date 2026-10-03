/**
 * src/services/eventBus/eventBusService.ts
 *
 * Orchestrator for the internal event bus observability stack (Issue #1055).
 *
 * One poll cycle does, in order:
 *
 *   1. read every watched queue (Redis + Celery/RabbitMQ)
 *   2. publish the depths as Prometheus samples
 *   3. evaluate backpressure and fire Slack / PagerDuty notifications
 *   4. ask the autoscaler for a replica count and apply it
 *
 * Everything is optional and failure-isolated: a broker that is down produces
 * failed samples (visible as metrics and on the alerts) rather than an
 * exception, and the cycle always completes.
 */

import { getRedisClient } from "../../lib/redis";
import { logger } from "../../utils/logger";
import { createAlertDispatcher } from "./alertDispatcher";
import {
  loadEventBusConfig,
  type AlertBotConfig,
  type AutoscalerConfig,
  type EventBusConfig,
} from "./config";
import {
  recordAutoscalerEvaluation,
  recordBackpressureEvaluation,
  recordQueueSamples,
} from "./eventBusMetrics";
import { QueueDepthCollector } from "./queueDepthCollector";
import {
  QueueBackpressureBot,
  thresholdsFromQueues,
} from "./queueBackpressureBot";
import {
  AmqpQueueDepthReader,
  NodeRedisDepthReader,
  type MinimalRedisClient,
} from "./readers";
import { createScaleProvider } from "./scaleProviders";
import type {
  AlertDispatcher,
  AutoscalerEvaluation,
  BackpressureEvaluation,
  QueueDepthSample,
  ScaleDecision,
  ScaleProvider,
} from "./types";
import { WorkerAutoscaler } from "./workerAutoscaler";

export interface EventBusCycleResult {
  observedAt: string;
  samples: QueueDepthSample[];
  totalPending: number;
  probeErrors: string[];
  backpressure: BackpressureEvaluation;
  autoscaler: AutoscalerEvaluation;
  appliedScales: Array<{ pool: string; applied: boolean; error?: string }>;
  durationMs: number;
}

export interface EventBusServiceOptions {
  config?: EventBusConfig;
  collector?: QueueDepthCollector;
  dispatcher?: AlertDispatcher;
  scaleProvider?: ScaleProvider | null;
  now?: () => number;
}

export interface EventBusHistoryPoint {
  observedAt: string;
  totalPending: number;
  queues: Array<{ name: string; pending: number }>;
}

/** Payload returned by `GET /api/v1/admin/event-bus/queues`. */
export interface EventBusStatus {
  enabled: boolean;
  running: boolean;
  pollIntervalMs: number;
  alert: AlertBotConfig;
  autoscaler: AutoscalerConfig & { provider: string | null };
  queueCount: number;
  lastCycle: EventBusCycleResult | null;
  levels: Record<string, string>;
  scopeStates: ReturnType<QueueBackpressureBot["getScopeStates"]>;
}

export class EventBusService {
  private readonly config: EventBusConfig;
  private readonly collector: QueueDepthCollector;
  private readonly bot: QueueBackpressureBot;
  private readonly autoscaler: WorkerAutoscaler;
  private readonly thresholds: Map<
    string,
    { warning: number; critical: number }
  >;
  private readonly now: () => number;
  private timer: ReturnType<typeof setInterval> | null = null;
  private inFlight: Promise<EventBusCycleResult> | null = null;
  private lastCycle: EventBusCycleResult | null = null;
  private readonly history: EventBusHistoryPoint[] = [];
  private amqpReader: AmqpQueueDepthReader | null = null;
  private lastDecisions: ScaleDecision[] = [];

  constructor(options: EventBusServiceOptions = {}) {
    this.config = options.config ?? loadEventBusConfig();
    this.now = options.now ?? Date.now;

    this.collector =
      options.collector ??
      new QueueDepthCollector({
        queues: this.config.queues,
        redis: this.buildRedisReader(),
        amqp: this.buildAmqpReader(),
        probeTimeoutMs: this.config.probeTimeoutMs,
        now: this.now,
      });

    this.thresholds = thresholdsFromQueues(this.config.queues, {
      warning: this.config.alert.threshold,
      critical: this.config.alert.criticalThreshold,
    });

    this.autoscaler = new WorkerAutoscaler({
      config: this.config.autoscaler,
      provider:
        options.scaleProvider ?? createScaleProvider(this.providerName()),
      now: this.now,
    });

    this.bot = new QueueBackpressureBot({
      config: this.config.alert,
      dispatcher: options.dispatcher ?? this.buildDispatcher(),
      thresholds: this.thresholds,
      resolveDesiredReplicas: (pool) =>
        pool
          ? (this.lastDecisions.find((d) => d.pool === pool)?.to ?? null)
          : null,
      now: this.now,
      dispatch: this.config.enabled,
    });
  }

  private providerName(): string {
    return process.env.EVENT_BUS_AUTOSCALE_PROVIDER ?? "noop";
  }

  private buildRedisReader() {
    const client = getRedisClient();
    if (!client) return null;
    return new NodeRedisDepthReader(client as unknown as MinimalRedisClient);
  }

  private buildAmqpReader() {
    if (!this.config.amqpUrl) return null;
    this.amqpReader = new AmqpQueueDepthReader({
      url: this.config.amqpUrl,
      managementUrl: this.config.rabbitmqManagementUrl,
      vhost: this.config.rabbitmqVhost,
      timeoutMs: this.config.probeTimeoutMs,
    });
    return this.amqpReader;
  }

  private buildDispatcher() {
    return createAlertDispatcher({
      slackWebhookUrl: this.config.slackWebhookUrl,
      pagerdutyRoutingKey: this.config.pagerdutyRoutingKey,
      enabled: this.config.enabled,
      now: this.now,
    });
  }

  getConfig(): EventBusConfig {
    return this.config;
  }

  getCollector(): QueueDepthCollector {
    return this.collector;
  }

  /** Start the polling loop. A no-op when disabled via configuration. */
  start(): void {
    if (this.timer) {
      logger.warn("[EventBus] Service is already running");
      return;
    }
    if (!this.config.enabled) {
      logger.info(
        "[EventBus] Monitoring disabled (EVENT_BUS_MONITORING_ENABLED=false)",
      );
      return;
    }
    void this.runCycle().catch((error) => {
      logger.error(
        "[EventBus] Initial cycle failed:",
        error instanceof Error ? error.message : error,
      );
    });
    this.timer = setInterval(() => {
      void this.runCycle().catch((error) => {
        logger.error(
          "[EventBus] Cycle failed:",
          error instanceof Error ? error.message : error,
        );
      });
    }, this.config.pollIntervalMs);
    this.timer.unref?.();
    logger.info(
      `[EventBus] Started with ${this.config.pollIntervalMs}ms polling interval over ${this.config.queues.length} queue(s)`,
    );
  }

  /** Stop the polling loop and release the broker connection. */
  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await this.amqpReader?.close();
    this.amqpReader = null;
    logger.info("[EventBus] Stopped");
  }

  isRunning(): boolean {
    return this.timer !== null;
  }

  /**
   * Run one cycle. Concurrent callers share the in-flight cycle so a slow
   * broker cannot queue up duplicate work.
   */
  async runCycle(): Promise<EventBusCycleResult> {
    if (this.inFlight) return this.inFlight;
    this.inFlight = this.executeCycle().finally(() => {
      this.inFlight = null;
    });
    return this.inFlight;
  }

  private async executeCycle(): Promise<EventBusCycleResult> {
    const startedAt = this.now();
    const report = await this.collector.collect();

    recordQueueSamples(
      report.samples,
      report.totalPending,
      this.thresholdsFor(),
    );

    // Refresh replica baselines before deciding, so a scale action is always
    // computed against the provider's current view of the world.
    const pools = this.config.autoscaler.pools.length
      ? this.config.autoscaler.pools
      : [...new Set(report.samples.map((sample) => sample.pool))];
    for (const pool of pools) {
      await this.autoscaler.refreshReplicaCount(pool);
    }

    const autoscaler = await this.autoscaler.evaluate(report.samples);
    this.lastDecisions = autoscaler.decisions;
    const appliedScales = await this.autoscaler.apply(autoscaler);

    const backpressure = await this.bot.evaluate(
      report.samples,
      report.probeErrors,
    );

    recordBackpressureEvaluation(backpressure);
    recordAutoscalerEvaluation(autoscaler);

    const result: EventBusCycleResult = {
      observedAt: report.observedAt,
      samples: report.samples,
      totalPending: report.totalPending,
      probeErrors: report.probeErrors,
      backpressure,
      autoscaler,
      appliedScales,
      durationMs: Math.max(0, this.now() - startedAt),
    };
    this.lastCycle = result;
    this.recordHistory({
      observedAt: result.observedAt,
      totalPending: result.totalPending,
      queues: result.samples.map((sample) => ({
        name: sample.name,
        pending: sample.pending,
      })),
    });

    if (result.probeErrors.length > 0) {
      logger.warn(
        `[EventBus] ${result.probeErrors.length} queue probe(s) failed: ${result.probeErrors.join("; ")}`,
      );
    }
    const active = Object.entries(backpressure.levels).filter(
      ([, level]) => level !== "ok",
    );
    if (active.length > 0) {
      logger.warn(
        `[EventBus] Backlog ${result.totalPending} message(s) — ${active
          .map(([scope, level]) => `${scope}=${level}`)
          .join(", ")}`,
      );
    }

    return result;
  }

  /**
   * Warning threshold per queue, for the `event_bus_queue_backlog_ratio` gauge.
   *
   * Queues without an explicit override still get a ratio, expressed against
   * the global threshold — otherwise the series would silently be missing for
   * exactly the queues nobody bothered to customise.
   */
  private thresholdsFor(): Map<string, number> {
    const fallback = this.config.alert.threshold;
    return new Map(
      this.collector
        .getQueues()
        .map(
          (queue) =>
            [
              queue.name,
              this.thresholds.get(queue.name)?.warning ?? fallback,
            ] as const,
        ),
    );
  }

  /** Bounded FIFO of per-cycle backlogs for the admin history endpoint. */
  private recordHistory(point: EventBusHistoryPoint): void {
    this.history.push(point);
    while (this.history.length > this.config.historySize) {
      this.history.shift();
    }
  }

  /** Snapshot for the admin endpoint. */
  getStatus(): EventBusStatus {
    return {
      enabled: this.config.enabled,
      running: this.isRunning(),
      pollIntervalMs: this.config.pollIntervalMs,
      alert: this.config.alert,
      autoscaler: {
        ...this.config.autoscaler,
        provider: this.providerName(),
      },
      queueCount: this.collector.getQueues().length,
      lastCycle: this.lastCycle,
      levels: this.bot.getLevels(),
      scopeStates: this.bot.getScopeStates(),
    };
  }

  /** Recent per-queue backlog history, oldest first. */
  getHistory(limit?: number): EventBusHistoryPoint[] {
    const size = limit ?? this.config.historySize;
    if (size >= this.history.length) return [...this.history];
    return this.history.slice(this.history.length - size);
  }
}

let instance: EventBusService | null = null;

/** Lazily construct the process-wide service (avoids sockets at import time). */
export function getEventBusService(): EventBusService {
  if (!instance) instance = new EventBusService();
  return instance;
}

/** Test seam: replace the process-wide service. */
export function setEventBusService(service: EventBusService | null): void {
  instance = service;
}
