import { logger } from "../utils/logger";
import { AlertSeverity, AlertType, NotificationService } from "./notificationService";

export interface BridgeRelayerHealthMonitorOptions {
  getPendingCount: () => Promise<number>;
  restartWorker: () => Promise<void> | void;
  notifications?: Pick<NotificationService, "sendAlert">;
  backlogThreshold?: number;
  failureThreshold?: number;
}

export class BridgeRelayerHealthMonitor {
  private consecutiveFailures = 0;
  private backlogAlertActive = false;
  private readonly threshold: number;
  private readonly failureThreshold: number;
  constructor(private readonly options: BridgeRelayerHealthMonitorOptions) {
    this.threshold = options.backlogThreshold ?? 50;
    this.failureThreshold = options.failureThreshold ?? 3;
  }

  async check(): Promise<{ pending: number; healthy: boolean }> {
    const pending = await this.options.getPendingCount();
    if (pending > this.threshold && !this.backlogAlertActive) {
      this.backlogAlertActive = true;
      await this.options.notifications?.sendAlert({ type: AlertType.HEALTH_CHECK_FAILURE, severity: AlertSeverity.HIGH, title: "Bridge relayer backlog exceeded", message: `${pending} cross-chain messages are pending (threshold ${this.threshold}).`, details: { pending, threshold: this.threshold }, timestamp: new Date(), service: "bridge-relayer-health" });
    } else if (pending <= this.threshold) {
      this.backlogAlertActive = false;
    }
    return { pending, healthy: pending <= this.threshold };
  }

  async recordWorkerFailure(error: unknown): Promise<boolean> {
    this.consecutiveFailures += 1;
    if (this.consecutiveFailures < this.failureThreshold) return false;
    try {
      await this.options.restartWorker();
      this.consecutiveFailures = 0;
      logger.warn("[BridgeRelayerHealth] Worker restarted after repeated failures");
      return true;
    } catch (restartError) {
      logger.error("[BridgeRelayerHealth] Worker restart failed", { error, restartError });
      return false;
    }
  }

  recordWorkerSuccess(): void { this.consecutiveFailures = 0; }
}