/**
 * src/services/eventBus/workerAutoscaler.ts
 *
 * Queue-depth-driven worker autoscaling (Issue #1055).
 *
 * Given the live backlog of a worker pool, the autoscaler derives the replica
 * count that keeps the queue inside its comfort zone:
 *
 *     desired = ceil(pending / targetMessagesPerReplica)
 *
 * and clamps it into `[minReplicas, maxReplicas]`. The decision is then passed
 * through a set of guard rails before anything is mutated:
 *
 * * `maxScaleStep`      — caps how fast a pool may grow or shrink.
 * * `cooldownMs`        — minimum gap between two actions on the same pool.
 * * `scaleDownStabilizationMs` — replicas are only removed once the pool has
 *   stayed under `scaleDownThreshold` for a while, so a backlog that is merely
 *   draining does not cause the pool to flap.
 * * `enabled = false`    — the autoscaler is purely advisory; it still reports
 *   the desired replica count but never calls the provider.
 *
 * Scale mutations go through a `ScaleProvider`, so the same logic drives Docker
 * Compose/Swarm, Kubernetes Deployments or an HTTP webhook without any code
 * change beyond picking a provider.
 */

import { logger } from "../../utils/logger";
import type { AutoscalerConfig } from "./config";
import type {
  AutoscalerEvaluation,
  QueueDepthSample,
  ScaleDecision,
  ScaleProvider,
} from "./types";
import { UNKNOWN_DEPTH } from "./queueDepthCollector";

export interface WorkerAutoscalerOptions {
  config: AutoscalerConfig;
  provider?: ScaleProvider | null;
  now?: () => number;
}

interface PoolState {
  /** Backlog last seen for the pool. */
  lastPending: number;
  /** When the backlog last dropped to or below `scaleDownThreshold`. */
  quietSince: number | null;
  /** Timestamp of the last mutation applied to this pool. */
  lastActionAt: number | null;
  /** Replica count the autoscaler last asked for. */
  lastDesired: number | null;
  /** Replica count reported by the provider on the previous cycle. */
  lastKnown: number | null;
}

/** Sum the backlog of every queue drained by `pool`. */
function pendingForPool(samples: QueueDepthSample[], pool: string): number {
  return samples
    .filter(
      (sample) => sample.pool === pool && sample.pending !== UNKNOWN_DEPTH,
    )
    .reduce((total, sample) => total + sample.pending, 0);
}

export class WorkerAutoscaler {
  private readonly config: AutoscalerConfig;
  private readonly provider: ScaleProvider | null;
  private readonly now: () => number;
  private readonly pools = new Map<string, PoolState>();

  constructor(options: WorkerAutoscalerOptions) {
    this.config = options.config;
    this.provider = options.provider ?? null;
    this.now = options.now ?? Date.now;
  }

  /** Compute the replica count a pool needs for a given backlog. */
  desiredReplicasFor(pending: number): number {
    const { minReplicas, maxReplicas, targetMessagesPerReplica } = this.config;
    if (pending <= 0) return minReplicas;
    const raw = Math.ceil(pending / Math.max(1, targetMessagesPerReplica));
    return Math.min(maxReplicas, Math.max(minReplicas, raw));
  }

  /**
   * Decide what to do for every pool present in `samples`.
   *
   * Read-only: providers are only called from `apply()`.
   */
  async evaluate(samples: QueueDepthSample[]): Promise<AutoscalerEvaluation> {
    const pools = this.poolsToManage(samples);
    const decisions: ScaleDecision[] = [];
    const desired: Record<string, number> = {};

    for (const pool of pools) {
      const pending = pendingForPool(samples, pool);
      const target = this.desiredReplicasFor(pending);
      desired[pool] = target;

      const state = this.stateFor(pool);
      state.lastPending = pending;
      if (pending <= this.config.scaleDownThreshold) {
        state.quietSince ??= this.now();
      } else {
        state.quietSince = null;
      }
      state.lastDesired = target;

      const current = state.lastKnown;
      if (current === null) {
        // The provider has not reported a replica count yet — adopt the
        // computed target as the baseline instead of guessing a delta.
        decisions.push(
          this.decision(
            pool,
            "none",
            null,
            target,
            pending,
            "Baseline adopted; awaiting the next provider read",
            "unknown-current",
          ),
        );
        continue;
      }

      const step = this.config.maxScaleStep;
      const stepped =
        target > current
          ? Math.min(target, current + step)
          : Math.max(target, current - step);
      const clamped = stepped !== target ? "max-scale-step" : null;

      if (stepped === current) {
        decisions.push(
          this.decision(
            pool,
            "none",
            current,
            current,
            pending,
            "Replica count already matches the target",
            null,
          ),
        );
        continue;
      }

      if (stepped > current) {
        decisions.push(
          this.decision(
            pool,
            "scale_up",
            current,
            stepped,
            pending,
            `Backlog of ${pending} messages needs ${stepped} replicas`,
            clamped,
          ),
        );
        continue;
      }

      // Scale-down guards.
      const quietSince = state.quietSince;
      const settled =
        quietSince !== null &&
        this.now() - quietSince >= this.config.scaleDownStabilizationMs;
      if (!settled) {
        decisions.push(
          this.decision(
            pool,
            "none",
            current,
            current,
            pending,
            `Scale-down deferred: backlog must stay under ${this.config.scaleDownThreshold} for ${this.config.scaleDownStabilizationMs}ms`,
            "scale-down-stabilization",
          ),
        );
        continue;
      }
      if (this.config.minReplicas >= 1 && stepped < 1) {
        decisions.push(
          this.decision(
            pool,
            "none",
            current,
            current,
            pending,
            "Scale-down blocked: pools keep at least one replica",
            "min-replicas",
          ),
        );
        continue;
      }
      decisions.push(
        this.decision(
          pool,
          "scale_down",
          current,
          stepped,
          pending,
          `Backlog drained to ${pending} messages; releasing ${current - stepped} replica(s)`,
          clamped,
        ),
      );
    }

    return { decisions, desired, enabled: this.config.enabled };
  }

  /**
   * Apply the decisions produced by `evaluate()`.
   *
   * Respects the autoscaler cooldown and the `enabled` flag; a provider failure
   * is logged and the remaining pools still get processed.
   */
  async apply(
    evaluation: AutoscalerEvaluation,
  ): Promise<Array<{ pool: string; applied: boolean; error?: string }>> {
    const results: Array<{ pool: string; applied: boolean; error?: string }> =
      [];

    for (const decision of evaluation.decisions) {
      if (decision.action === "none") {
        continue;
      }
      if (!this.config.enabled) {
        results.push({ pool: decision.pool, applied: false });
        continue;
      }
      if (!this.provider) {
        logger.warn(
          `[EventBus] Autoscaler wanted to ${decision.action} ${decision.pool} but no scale provider is configured`,
        );
        results.push({
          pool: decision.pool,
          applied: false,
          error: "no-provider",
        });
        continue;
      }

      const state = this.stateFor(decision.pool);
      const lastAction = state.lastActionAt;
      if (
        lastAction !== null &&
        this.now() - lastAction < this.config.cooldownMs
      ) {
        results.push({
          pool: decision.pool,
          applied: false,
          error: "cooldown",
        });
        continue;
      }

      try {
        await this.provider.setReplicaCount(decision.pool, decision.to);
        state.lastActionAt = this.now();
        state.lastKnown = decision.to;
        logger.info(
          `[EventBus] Autoscaled ${decision.pool} ${decision.from} -> ${decision.to} (${decision.reason})`,
        );
        results.push({ pool: decision.pool, applied: true });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.error(
          `[EventBus] Failed to scale ${decision.pool} to ${decision.to}: ${message}`,
        );
        results.push({ pool: decision.pool, applied: false, error: message });
      }
    }

    return results;
  }

  /** Ask the provider for the current replica count of a pool. */
  async refreshReplicaCount(pool: string): Promise<number | null> {
    if (!this.provider) return this.stateFor(pool).lastKnown;
    try {
      const count = await this.provider.getReplicaCount(pool);
      if (count !== null) this.stateFor(pool).lastKnown = count;
      return count;
    } catch (error) {
      logger.warn(
        `[EventBus] Could not read replica count for ${pool}:`,
        error instanceof Error ? error.message : error,
      );
      return this.stateFor(pool).lastKnown;
    }
  }

  private poolsToManage(samples: QueueDepthSample[]): string[] {
    if (this.config.pools.length > 0) return [...this.config.pools];
    return [...new Set(samples.map((sample) => sample.pool))].sort();
  }

  private stateFor(pool: string): PoolState {
    let state = this.pools.get(pool);
    if (!state) {
      state = {
        lastPending: 0,
        quietSince: null,
        lastActionAt: null,
        lastDesired: null,
        lastKnown: null,
      };
      this.pools.set(pool, state);
    }
    return state;
  }

  private decision(
    pool: string,
    action: ScaleDecision["action"],
    from: number | null,
    to: number,
    pending: number,
    reason: string,
    limitedBy: string | null,
  ): ScaleDecision {
    return {
      pool,
      action,
      from,
      to,
      reason,
      pending,
      limitedBy,
      decidedAt: new Date(this.now()).toISOString(),
    };
  }
}
