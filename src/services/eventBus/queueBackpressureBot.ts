/**
 * src/services/eventBus/queueBackpressureBot.ts
 *
 * Queue backpressure alert bot (Issue #1055).
 *
 * Watches the samples produced by `QueueDepthCollector` and raises an incident
 * when a queue — or the event bus as a whole — holds more than
 * `threshold` unhandled messages (1,000 by default).
 *
 * Design notes:
 *
 * * **Hysteresis.** A scope that has alerted only clears once its backlog falls
 *   below `threshold * recoveryRatio`, so a queue oscillating around the
 *   threshold cannot flap the pager.
 * * **Cooldown.** Re-notifications for an already-alerting scope are suppressed
 *   for `cooldownMs`, then re-sent as `reminder` so an unresolved backlog keeps
 *   visibility without becoming a flood.
 * * **Escalation.** Crossing the critical threshold promotes an open warning to
 *   a `critical` incident immediately (page), which is what PagerDuty needs.
 * * **Fan-out.** Every alert carries a per-queue breakdown and the aggregate
 *   backlog so the responder can see whether one queue or the whole bus is
 *   responsible, and the target replica count the autoscaler wants.
 */

import { logger } from "../../utils/logger";
import type { AlertBotConfig } from "./config";
import type {
  AlertDispatcher,
  BackpressureAlert,
  BackpressureEvaluation,
  BackpressureLevel,
  QueueDepthSample,
} from "./types";
import { UNKNOWN_DEPTH } from "./queueDepthCollector";

interface ScopeState {
  level: BackpressureLevel;
  lastNotifiedAt: number | null;
  /** Backlog observed on the most recent cycle, for reporting. */
  lastPending: number;
  /** Peak backlog seen while the scope was open, for the incident summary. */
  peakPending: number;
  lastAlertAt: string | null;
}

export interface QueueBackpressureBotOptions {
  config: AlertBotConfig;
  dispatcher: AlertDispatcher;
  /** Per-queue threshold overrides, keyed by queue name. */
  thresholds?: Map<string, { warning: number; critical: number }>;
  /** Supplies the desired replica count shown on alerts. */
  resolveDesiredReplicas?: (pool: string | null) => number | null;
  now?: () => number;
  /** Disables outbound dispatch (used by tests and dry-run mode). */
  dispatch?: boolean;
}

export class QueueBackpressureBot {
  private readonly config: AlertBotConfig;
  private readonly dispatcher: AlertDispatcher;
  private readonly overrides: Map<
    string,
    { warning: number; critical: number }
  >;
  private readonly resolveDesiredReplicas: (
    pool: string | null,
  ) => number | null;
  private readonly now: () => number;
  private readonly dispatch: boolean;
  private readonly scopes = new Map<string, ScopeState>();

  constructor(options: QueueBackpressureBotOptions) {
    this.config = options.config;
    this.dispatcher = options.dispatcher;
    this.overrides = options.thresholds ?? new Map();
    this.resolveDesiredReplicas =
      options.resolveDesiredReplicas ?? (() => null);
    this.now = options.now ?? Date.now;
    this.dispatch = options.dispatch ?? true;
  }

  /** Current level per scope, including scopes that have recovered. */
  getLevels(): Record<string, BackpressureLevel> {
    return Object.fromEntries(
      [...this.scopes.entries()].map(([scope, state]) => [scope, state.level]),
    );
  }

  /** Incident bookkeeping per scope, surfaced by the admin endpoint. */
  getScopeStates(): Record<
    string,
    {
      level: BackpressureLevel;
      lastPending: number;
      peakPending: number;
      lastNotifiedAt: string | null;
      lastAlertAt: string | null;
    }
  > {
    return Object.fromEntries(
      [...this.scopes.entries()].map(([scope, state]) => [
        scope,
        {
          level: state.level,
          lastPending: state.lastPending,
          peakPending: state.peakPending,
          lastNotifiedAt:
            state.lastNotifiedAt === null
              ? null
              : new Date(state.lastNotifiedAt).toISOString(),
          lastAlertAt: state.lastAlertAt,
        },
      ]),
    );
  }

  /** Forget a scope, e.g. after a queue is removed from the catalogue. */
  forget(scope: string): void {
    this.scopes.delete(scope);
  }

  /**
   * Evaluate one collection cycle.
   *
   * Never throws: a dispatcher failure is logged and the scope state is still
   * updated, because losing the alert path must not stop queue monitoring.
   */
  async evaluate(
    samples: QueueDepthSample[],
    probeErrors: string[] = [],
  ): Promise<BackpressureEvaluation> {
    const observedAt = new Date(this.now()).toISOString();
    const healthy = samples.filter(
      (sample) => sample.pending !== UNKNOWN_DEPTH,
    );
    const failed = samples.filter((sample) => sample.pending === UNKNOWN_DEPTH);

    const alerts: BackpressureAlert[] = [];
    const levels: Record<string, BackpressureLevel> = {};
    const criticalScopes: string[] = [];
    const totalPending = healthy.reduce((total, s) => total + s.pending, 0);

    for (const sample of healthy) {
      const thresholds = this.thresholdsFor(sample.name);
      const outcome = this.evaluateScope(
        sample.name,
        sample.pending,
        thresholds,
        {
          observedAt,
          probeErrors,
          breakdown: [sample],
          pool: sample.pool,
        },
      );
      levels[sample.name] = outcome.level;
      if (outcome.level === "critical") criticalScopes.push(sample.name);
      if (outcome.alert) alerts.push(outcome.alert);
    }

    if (this.config.alertOnTotal) {
      const outcome = this.evaluateScope(
        this.config.totalScopeName,
        totalPending,
        {
          warning: this.config.threshold,
          critical: this.config.criticalThreshold,
        },
        {
          observedAt,
          probeErrors,
          breakdown: healthy,
          pool: null,
        },
      );
      levels[this.config.totalScopeName] = outcome.level;
      if (outcome.level === "critical")
        criticalScopes.push(this.config.totalScopeName);
      if (outcome.alert) alerts.push(outcome.alert);
    }

    // A failed probe is not a backpressure event, but it is a blind spot:
    // record it as ok so a stale "critical" level cannot persist forever.
    for (const sample of failed) {
      levels[sample.name] = "ok";
    }

    for (const alert of alerts) {
      await this.dispatchAlert(alert);
    }

    return { alerts, levels, totalPending, criticalScopes };
  }

  private thresholdsFor(queueName: string): {
    warning: number;
    critical: number;
  } {
    const override = this.overrides.get(queueName);
    if (override) return override;
    return {
      warning: this.config.threshold,
      critical: this.config.criticalThreshold,
    };
  }

  private evaluateScope(
    scope: string,
    pending: number,
    thresholds: { warning: number; critical: number },
    context: {
      observedAt: string;
      probeErrors: string[];
      breakdown: QueueDepthSample[];
      pool: string | null;
    },
  ): { level: BackpressureLevel; alert: BackpressureAlert | null } {
    const state = this.stateFor(scope);
    const recoveryThreshold = thresholds.warning * this.config.recoveryRatio;

    // The backlog a queue must fall back under before an open incident closes.
    // Checked before anything else so a queue oscillating around the threshold
    // neither resolves nor re-fires.
    if (pending < recoveryThreshold) {
      const wasAlerting = state.level !== "ok";
      state.lastPending = pending;
      state.level = "ok";
      if (wasAlerting && this.config.resolveOnRecovery) {
        state.lastNotifiedAt = this.now();
        state.lastAlertAt = context.observedAt;
        return {
          level: "ok",
          alert: this.buildAlert(
            scope,
            context,
            pending,
            thresholds,
            "ok",
            "resolve",
          ),
        };
      }
      return { level: "ok", alert: null };
    }

    const rawLevel: BackpressureLevel =
      pending >= thresholds.critical ? "critical" : "warning";

    // A pending backlog between the recovery mark and the warning threshold
    // holds the current level without notifying again.
    if (pending < thresholds.warning) {
      state.lastPending = pending;
      return { level: state.level, alert: null };
    }

    const escalated = state.level !== rawLevel;
    const cooldownElapsed =
      state.lastNotifiedAt === null ||
      this.now() - state.lastNotifiedAt >= this.config.cooldownMs;

    const level = escalated ? rawLevel : state.level;
    state.lastPending = pending;
    state.peakPending = Math.max(state.peakPending, pending);

    if (!escalated && !cooldownElapsed) {
      return { level, alert: null };
    }

    state.level = level;
    state.lastNotifiedAt = this.now();
    state.lastAlertAt = context.observedAt;
    return {
      level,
      alert: this.buildAlert(
        scope,
        context,
        pending,
        thresholds,
        level,
        escalated ? "trigger" : "reminder",
      ),
    };
  }

  private stateFor(scope: string): ScopeState {
    let state = this.scopes.get(scope);
    if (!state) {
      state = {
        level: "ok",
        lastNotifiedAt: null,
        lastPending: 0,
        peakPending: 0,
        lastAlertAt: null,
      };
      this.scopes.set(scope, state);
    }
    return state;
  }

  private buildAlert(
    scope: string,
    context: {
      observedAt: string;
      probeErrors: string[];
      breakdown: QueueDepthSample[];
      pool: string | null;
    },
    pending: number,
    thresholds: { warning: number; critical: number },
    level: BackpressureLevel,
    kind: BackpressureAlert["kind"],
  ): BackpressureAlert {
    return {
      scope,
      pool: context.pool,
      level,
      pending,
      threshold: thresholds.warning,
      criticalThreshold: thresholds.critical,
      overshootPercent:
        thresholds.warning > 0
          ? Math.round((pending / thresholds.warning) * 1000) / 10
          : 0,
      kind,
      observedAt: context.observedAt,
      queues: [...context.breakdown]
        .sort((a, b) => b.pending - a.pending)
        .map((sample) => ({
          name: sample.name,
          pool: sample.pool,
          transport: sample.transport,
          pending: sample.pending,
          consumers: sample.consumers,
          unacked: sample.unacked,
        })),
      probeErrors: context.probeErrors,
      desiredReplicas: this.resolveDesiredReplicas(context.pool),
    };
  }

  private async dispatchAlert(alert: BackpressureAlert): Promise<void> {
    if (!this.dispatch) return;
    try {
      if (alert.kind === "resolve") {
        await this.dispatcher.resolve(alert);
      } else {
        await this.dispatcher.trigger(alert);
      }
    } catch (error) {
      logger.error(
        `[EventBus] Failed to dispatch ${alert.kind} notification for ${alert.scope}:`,
        error instanceof Error ? error.message : error,
      );
    }
  }
}

/**
 * Reads a per-queue threshold override map out of `QueueDescriptor`s, so
 * individual queues can opt into a stricter limit than the global default.
 */
export function thresholdsFromQueues(
  queues: Array<{
    name: string;
    warningThreshold?: number;
    criticalThreshold?: number;
  }>,
  defaults: { warning: number; critical: number },
): Map<string, { warning: number; critical: number }> {
  const map = new Map<string, { warning: number; critical: number }>();
  for (const queue of queues) {
    const warning = queue.warningThreshold ?? defaults.warning;
    const critical = Math.max(
      warning,
      queue.criticalThreshold ?? defaults.critical,
    );
    if (warning !== defaults.warning || critical !== defaults.critical) {
      map.set(queue.name, { warning, critical });
    }
  }
  return map;
}
