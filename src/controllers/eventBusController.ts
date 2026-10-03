/**
 * eventBusController.ts
 *
 * Admin endpoints for the internal event bus metrics and queue backpressure
 * alert bot (Issue #1055).
 *
 * Exposed surface:
 *   GET /api/v1/admin/event-bus/queues     — per-queue backlog + thresholds
 *   GET /api/v1/admin/event-bus/history    — recent backlog trend
 *   GET /api/v1/admin/event-bus/alerts     — incident levels + last cycle
 *   GET /api/v1/admin/event-bus/autoscaler — desired/actual worker replicas
 *   POST /api/v1/admin/event-bus/collect   — force an out-of-band collection
 *
 * Read handlers never touch Redis or the broker directly: they project the
 * snapshot produced by the last polling cycle, so a dashboard refresh cannot
 * amplify load on an already-struggling broker.
 */

import type { Request, Response } from "express";
import { sendApiError } from "../lib/apiError.js";
import {
  getEventBusService,
  type EventBusService,
} from "../services/eventBus/eventBusService";
import { UNKNOWN_DEPTH } from "../services/eventBus/queueDepthCollector";

type ServiceResolver = () => EventBusService;

function resolveService(
  resolve: ServiceResolver = getEventBusService,
): EventBusService {
  return resolve();
}

/**
 * Bind a service resolver to express-shaped handlers.
 *
 * The route module uses the default (process-wide) service; tests pass their
 * own instance so they never touch Redis, RabbitMQ, Slack or PagerDuty.
 */
export function createEventBusHandlers(
  resolve: ServiceResolver = getEventBusService,
) {
  return {
    queues: (req: Request, res: Response): void =>
      getEventBusQueues(req, res, resolve),
    history: (req: Request, res: Response): void =>
      getEventBusHistory(req, res, resolve),
    alerts: (req: Request, res: Response): void =>
      getEventBusAlerts(req, res, resolve),
    autoscaler: (req: Request, res: Response): void =>
      getEventBusAutoscaler(req, res, resolve),
    collect: (req: Request, res: Response): Promise<void> =>
      collectEventBusNow(req, res, resolve),
  };
}

function parseLimit(raw: unknown, fallback: number, max: number): number {
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(max, Math.floor(parsed));
}

/** GET /api/v1/admin/event-bus/queues */
export function getEventBusQueues(
  req: Request,
  res: Response,
  resolve: ServiceResolver = getEventBusService,
): void {
  const service = resolveService(resolve);
  const status = service.getStatus();
  const cycle = status.lastCycle;

  res.json({
    success: true,
    data: {
      monitoringEnabled: status.enabled,
      running: status.running,
      pollIntervalMs: status.pollIntervalMs,
      thresholds: {
        warning: status.alert.threshold,
        critical: status.alert.criticalThreshold,
        recoveryRatio: status.alert.recoveryRatio,
      },
      queues: service
        .getCollector()
        .getQueues()
        .map((descriptor) => {
          const sample = cycle?.samples.find((s) => s.name === descriptor.name);
          return {
            name: descriptor.name,
            pool: descriptor.pool,
            transport: descriptor.transport,
            key: descriptor.key ?? descriptor.channel ?? null,
            pending: sample ? sample.pending : null,
            unacked: sample ? sample.unacked : null,
            consumers: sample ? sample.consumers : null,
            oldestPendingAgeSeconds: sample
              ? sample.oldestPendingAgeSeconds
              : null,
            observedAt: sample ? sample.observedAt : null,
            error: sample ? (sample.error ?? null) : "not yet observed",
          };
        }),
      totals: {
        pending: cycle ? cycle.totalPending : 0,
        probeErrors: cycle ? cycle.probeErrors.length : 0,
        observedAt: cycle ? cycle.observedAt : null,
      },
    },
  });
}

/** GET /api/v1/admin/event-bus/history */
export function getEventBusHistory(
  req: Request,
  res: Response,
  resolve: ServiceResolver = getEventBusService,
): void {
  const service = resolveService(resolve);
  const limit = parseLimit(req.query.limit, 60, 720);

  res.json({
    success: true,
    data: {
      limit,
      points: service.getHistory(limit),
    },
  });
}

/** GET /api/v1/admin/event-bus/alerts */
export function getEventBusAlerts(
  _req: Request,
  res: Response,
  resolve: ServiceResolver = getEventBusService,
): void {
  const service = resolveService(resolve);
  const status = service.getStatus();
  const cycle = status.lastCycle;

  res.json({
    success: true,
    data: {
      bot: {
        threshold: status.alert.threshold,
        criticalThreshold: status.alert.criticalThreshold,
        cooldownMs: status.alert.cooldownMs,
        alertOnTotal: status.alert.alertOnTotal,
        totalScope: status.alert.totalScopeName,
        resolveOnRecovery: status.alert.resolveOnRecovery,
        slackConfigured: Boolean(process.env.SLACK_WEBHOOK_URL),
        pagerdutyConfigured: Boolean(process.env.PAGERDUTY_ROUTING_KEY),
      },
      levels: status.levels,
      scopeStates: status.scopeStates,
      criticalScopes: cycle ? cycle.backpressure.criticalScopes : [],
      lastAlerts: cycle ? cycle.backpressure.alerts : [],
    },
  });
}

/** GET /api/v1/admin/event-bus/autoscaler */
export function getEventBusAutoscaler(
  _req: Request,
  res: Response,
  resolve: ServiceResolver = getEventBusService,
): void {
  const service = resolveService(resolve);
  const status = service.getStatus();
  const cycle = status.lastCycle;

  res.json({
    success: true,
    data: {
      config: status.autoscaler,
      decisions: cycle ? cycle.autoscaler.decisions : [],
      desired: cycle ? cycle.autoscaler.desired : {},
      applied: cycle ? cycle.appliedScales : [],
    },
  });
}

/** POST /api/v1/admin/event-bus/collect */
export async function collectEventBusNow(
  _req: Request,
  res: Response,
  resolve: ServiceResolver = getEventBusService,
): Promise<void> {
  const service = resolveService(resolve);
  try {
    const cycle = await service.runCycle();
    res.json({
      success: true,
      data: {
        observedAt: cycle.observedAt,
        durationMs: cycle.durationMs,
        totalPending: cycle.totalPending,
        probeErrors: cycle.probeErrors,
        queues: cycle.samples
          .filter((sample) => sample.pending !== UNKNOWN_DEPTH)
          .map((sample) => ({
            name: sample.name,
            pool: sample.pool,
            pending: sample.pending,
            consumers: sample.consumers,
            unacked: sample.unacked,
          })),
        levels: cycle.backpressure.levels,
        alerts: cycle.backpressure.alerts.map((alert) => ({
          scope: alert.scope,
          level: alert.level,
          kind: alert.kind,
          pending: alert.pending,
        })),
        autoscaler: cycle.autoscaler.decisions,
      },
    });
  } catch (err) {
    sendApiError(
      res,
      500,
      "INTERNAL_SERVER_ERROR",
      err instanceof Error ? err.message : "Failed to collect queue depths",
    );
  }
}
