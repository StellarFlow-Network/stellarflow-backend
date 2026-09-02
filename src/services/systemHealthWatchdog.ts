import { logger } from "../utils/logger";
import type {
  AlertSeverity,
  AlertType,
  NotificationService,
  SystemAlert,
} from "./notificationService";

export const WATCHDOG_POLL_INTERVAL_MS = 5_000;
const DEFAULT_PROBE_TIMEOUT_MS = 4_000;
const DEFAULT_RESTART_COOLDOWN_MS = 30_000;

export type WatchdogCheckStatus = "healthy" | "degraded";

export interface WatchdogCheck {
  status: WatchdogCheckStatus;
  latencyMs: number;
  checkedAt: string;
  message?: string;
  details?: Record<string, unknown>;
}

export interface WatchdogSnapshot {
  status: WatchdogCheckStatus;
  checkedAt: string;
  checks: Record<string, WatchdogCheck>;
}

export interface QueueProbe {
  name: string;
  getDepth: () => number | Promise<number>;
  maxHealthyDepth: number;
}

export interface ManagedWorker {
  name: string;
  getLastHeartbeatAt: () => Date | number | null;
  restart: () => void | Promise<void>;
  heartbeatTimeoutMs: number;
  restartCooldownMs?: number;
}

interface WorkerState {
  worker: ManagedWorker;
  registeredAt: number;
  lastRestartAt: number;
  restarting: boolean;
}

interface WatchdogDependencies {
  probes?: Record<string, () => Promise<unknown>>;
  notifications?: Pick<NotificationService, "sendAlert">;
  pollIntervalMs?: number;
  probeTimeoutMs?: number;
  now?: () => number;
}

function positiveNumber(value: number, label: string): number {
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${label} must be a positive number`);
  }
  return value;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function defaultProbes(): Record<string, () => Promise<unknown>> {
  return {
    database: async () => {
      const { default: prisma } = await import("../lib/prisma.js");
      return prisma.$queryRaw`SELECT 1`;
    },
    horizon: async () => {
      const { default: stellarProvider } =
        await import("../lib/stellarProvider.js");
      return stellarProvider.getServer().root();
    },
    soroban: async () => {
      const { default: stellarProvider } =
        await import("../lib/stellarProvider.js");
      const health = await stellarProvider.getRpcServer().getHealth();
      if (
        health &&
        typeof health === "object" &&
        "status" in health &&
        String(health.status).toLowerCase() !== "healthy"
      ) {
        throw new Error(`Soroban RPC reported status ${String(health.status)}`);
      }
      return health;
    },
  };
}

const defaultNotifications: Pick<NotificationService, "sendAlert"> = {
  async sendAlert(alert) {
    const { notificationService } = await import("./notificationService.js");
    return notificationService.sendAlert(alert);
  },
};

/**
 * Continuously supervises external connections, queue depths, and worker
 * heartbeats. Alerts are emitted only when a check transitions into a degraded
 * state, which prevents a five-second polling loop from flooding webhooks.
 */
export class SystemHealthWatchdog {
  private readonly probes: Record<string, () => Promise<unknown>>;
  private readonly notifications: Pick<NotificationService, "sendAlert">;
  private readonly pollIntervalMs: number;
  private readonly probeTimeoutMs: number;
  private readonly now: () => number;
  private readonly queues = new Map<string, QueueProbe>();
  private readonly workers = new Map<string, WorkerState>();
  private readonly activeDegradations = new Set<string>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private currentCheck: Promise<WatchdogSnapshot> | null = null;
  private snapshot: WatchdogSnapshot | null = null;

  constructor(dependencies: WatchdogDependencies = {}) {
    this.probes = dependencies.probes ?? defaultProbes();
    this.notifications = dependencies.notifications ?? defaultNotifications;
    this.pollIntervalMs = positiveNumber(
      dependencies.pollIntervalMs ?? WATCHDOG_POLL_INTERVAL_MS,
      "Watchdog poll interval",
    );
    this.probeTimeoutMs = positiveNumber(
      dependencies.probeTimeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS,
      "Watchdog probe timeout",
    );
    this.now = dependencies.now ?? Date.now;
  }

  registerQueue(queue: QueueProbe): () => void {
    positiveNumber(queue.maxHealthyDepth, `${queue.name} maximum queue depth`);
    this.queues.set(queue.name, queue);
    return () => this.queues.delete(queue.name);
  }

  registerWorker(worker: ManagedWorker): () => void {
    positiveNumber(
      worker.heartbeatTimeoutMs,
      `${worker.name} heartbeat timeout`,
    );
    if (worker.restartCooldownMs !== undefined) {
      positiveNumber(
        worker.restartCooldownMs,
        `${worker.name} restart cooldown`,
      );
    }
    this.workers.set(worker.name, {
      worker,
      registeredAt: this.now(),
      lastRestartAt: Number.NEGATIVE_INFINITY,
      restarting: false,
    });
    return () => this.workers.delete(worker.name);
  }

  start(): void {
    if (this.timer) return;
    void this.runOnce();
    this.timer = setInterval(() => void this.runOnce(), this.pollIntervalMs);
    this.timer.unref?.();
    logger.info(
      `[SystemHealthWatchdog] Started with ${this.pollIntervalMs}ms polling interval`,
    );
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    logger.info("[SystemHealthWatchdog] Stopped");
  }

  getSnapshot(): WatchdogSnapshot | null {
    if (!this.snapshot) return null;
    return {
      ...this.snapshot,
      checks: Object.fromEntries(
        Object.entries(this.snapshot.checks).map(([name, check]) => {
          const clonedCheck: WatchdogCheck = { ...check };
          if (check.details) clonedCheck.details = { ...check.details };
          return [name, clonedCheck];
        }),
      ),
    };
  }

  runOnce(): Promise<WatchdogSnapshot> {
    if (this.currentCheck) return this.currentCheck;
    this.currentCheck = this.performChecks().finally(() => {
      this.currentCheck = null;
    });
    return this.currentCheck;
  }

  private async performChecks(): Promise<WatchdogSnapshot> {
    const results = await Promise.all([
      ...Object.entries(this.probes).map(
        async ([name, probe]) => [name, await this.runProbe(probe)] as const,
      ),
      ...Array.from(this.queues.values()).map(
        async (queue) =>
          [`queue:${queue.name}`, await this.checkQueue(queue)] as const,
      ),
      ...Array.from(this.workers.values()).map(
        async (worker) =>
          [
            `worker:${worker.worker.name}`,
            await this.checkWorker(worker),
          ] as const,
      ),
    ]);

    const checks = Object.fromEntries(results);
    const snapshot: WatchdogSnapshot = {
      status: Object.values(checks).every((check) => check.status === "healthy")
        ? "healthy"
        : "degraded",
      checkedAt: new Date(this.now()).toISOString(),
      checks,
    };
    this.snapshot = snapshot;
    await this.reportTransitions(checks);
    return snapshot;
  }

  private async runProbe(
    probe: () => Promise<unknown>,
  ): Promise<WatchdogCheck> {
    const startedAt = this.now();
    try {
      await this.withTimeout(probe(), this.probeTimeoutMs);
      return this.result("healthy", startedAt);
    } catch (error) {
      return this.result("degraded", startedAt, errorMessage(error));
    }
  }

  private async checkQueue(queue: QueueProbe): Promise<WatchdogCheck> {
    const startedAt = this.now();
    try {
      const depth = await this.withTimeout(
        Promise.resolve(queue.getDepth()),
        this.probeTimeoutMs,
      );
      const details = { depth, maxHealthyDepth: queue.maxHealthyDepth };
      if (depth > queue.maxHealthyDepth) {
        return this.result(
          "degraded",
          startedAt,
          `Queue depth ${depth} exceeds threshold ${queue.maxHealthyDepth}`,
          details,
        );
      }
      return this.result("healthy", startedAt, undefined, details);
    } catch (error) {
      return this.result("degraded", startedAt, errorMessage(error));
    }
  }

  private async checkWorker(state: WorkerState): Promise<WatchdogCheck> {
    const startedAt = this.now();
    let heartbeat: Date | number | null;
    try {
      heartbeat = state.worker.getLastHeartbeatAt();
    } catch (error) {
      return this.result(
        "degraded",
        startedAt,
        `Worker heartbeat probe failed: ${errorMessage(error)}`,
      );
    }
    const heartbeatAt =
      heartbeat instanceof Date ? heartbeat.getTime() : heartbeat;
    const referenceTime = heartbeatAt ?? state.registeredAt;
    const heartbeatAgeMs = Math.max(0, startedAt - referenceTime);
    const details: Record<string, unknown> = {
      heartbeatAgeMs,
      heartbeatTimeoutMs: state.worker.heartbeatTimeoutMs,
      lastHeartbeatAt:
        heartbeatAt !== null ? new Date(heartbeatAt).toISOString() : null,
    };

    if (heartbeatAgeMs <= state.worker.heartbeatTimeoutMs) {
      return this.result("healthy", startedAt, undefined, details);
    }

    const cooldown =
      state.worker.restartCooldownMs ?? DEFAULT_RESTART_COOLDOWN_MS;
    if (!state.restarting && startedAt - state.lastRestartAt >= cooldown) {
      state.restarting = true;
      state.lastRestartAt = startedAt;
      try {
        await state.worker.restart();
        details.restarted = true;
      } catch (error) {
        details.restartError = errorMessage(error);
      } finally {
        state.restarting = false;
      }
    } else {
      details.restartSuppressedByCooldown = true;
    }

    return this.result(
      "degraded",
      startedAt,
      `Worker heartbeat is ${heartbeatAgeMs}ms old`,
      details,
    );
  }

  private result(
    status: WatchdogCheckStatus,
    startedAt: number,
    message?: string,
    details?: Record<string, unknown>,
  ): WatchdogCheck {
    const result: WatchdogCheck = {
      status,
      latencyMs: Math.max(0, this.now() - startedAt),
      checkedAt: new Date(this.now()).toISOString(),
    };
    if (message !== undefined) result.message = message;
    if (details !== undefined) result.details = details;
    return result;
  }

  private async reportTransitions(
    checks: Record<string, WatchdogCheck>,
  ): Promise<void> {
    const alerts: Promise<boolean>[] = [];
    for (const [name, check] of Object.entries(checks)) {
      if (check.status === "healthy") {
        this.activeDegradations.delete(name);
        continue;
      }
      if (this.activeDegradations.has(name)) continue;

      this.activeDegradations.add(name);
      const alert: SystemAlert = {
        type: "health_check_failure" as AlertType,
        severity: "high" as AlertSeverity,
        title: "System health degradation detected",
        message: check.message ?? `${name} health check failed`,
        timestamp: new Date(this.now()),
        service: `system-health-watchdog:${name}`,
      };
      if (check.details) alert.details = check.details;
      alerts.push(this.notifications.sendAlert(alert));
    }
    await Promise.allSettled(alerts);
  }

  private async withTimeout<T>(
    promise: Promise<T>,
    timeoutMs: number,
  ): Promise<T> {
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        promise,
        new Promise<T>((_resolve, reject) => {
          timeout = setTimeout(
            () =>
              reject(new Error(`Health probe timed out after ${timeoutMs}ms`)),
            timeoutMs,
          );
          timeout.unref?.();
        }),
      ]);
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  }
}

export const systemHealthWatchdog = new SystemHealthWatchdog();
