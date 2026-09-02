import { logger } from "../utils/logger";
import stellarProvider from "../lib/stellarProvider";
import { setLockdownState } from "../state/appState";
import { notificationService, AlertType, AlertSeverity } from "./notificationService";
import dotenv from "dotenv";

dotenv.config();

export class EmergencyPauseListener {
  private isRunning: boolean = false;
  private pollIntervalMs: number;
  private lastProcessedLedger: number = 0;
  private pollTimer: ReturnType<typeof setInterval> | null = null;

  constructor(pollIntervalMs: number = 10000) {
    this.pollIntervalMs = pollIntervalMs;
  }

  async start(): Promise<void> {
    if (this.isRunning) {
      logger.warn("[EmergencyPauseListener] is already running");
      return;
    }
    this.isRunning = true;
    logger.info("[EmergencyPauseListener] Starting listener for ProtocolPaused events");

    // Start with the latest ledger if possible to avoid fetching historical events
    // on every restart unless we persisted it. For simplicity, just fetch from recent.
    // In a real app we'd fetch the current network ledger.
    try {
        const rpc = stellarProvider.getRpcServer();
        const latestLedger = await rpc.getLatestLedger();
        this.lastProcessedLedger = latestLedger.sequence;
    } catch (e) {
        // Fallback
        this.lastProcessedLedger = 1;
    }

    await this.pollEvents();
    this.startPollingTimer();
  }

  private startPollingTimer(): void {
    this.pollTimer = setInterval(() => {
      this.pollEvents().catch((err) => {
        logger.networkError("[EmergencyPauseListener] Poll error:", { err });
      });
    }, this.pollIntervalMs);
  }

  private async pollEvents(): Promise<void> {
    const contractId = process.env.CONTRACT_ID?.trim();
    if (!contractId) return;

    const rpc = stellarProvider.getRpcServer() as any;

    let response: { events?: any[] };
    try {
      response = await rpc.getEvents({
        startLedger: Math.max(1, this.lastProcessedLedger),
        filters: [
          {
            type: "contract",
            contractIds: [contractId],
            topics: [["ProtocolPaused", "*", "*"]],
          },
          {
            type: "contract",
            contractIds: [contractId],
            topics: [["ProtocolPaused"]],
          },
        ],
        limit: 100,
      });
    } catch (err) {
      logger.networkError("[EmergencyPauseListener] poll failed:", { err });
      return;
    }

    let protocolPaused = false;
    let highestLedger = this.lastProcessedLedger;
    let lastEventDetails: any = null;

    for (const event of response.events ?? []) {
      try {
        const ledger = Number(event.ledger ?? 0);
        if (ledger > highestLedger) {
            highestLedger = ledger;
        }

        const topics = event.topic ?? [];
        if (topics.length > 0 && topics[0] === "ProtocolPaused") {
            protocolPaused = true;
            lastEventDetails = event;
        }
      } catch (err) {
        logger.error("[EmergencyPauseListener] Failed to parse event:", err);
      }
    }

    if (protocolPaused && lastEventDetails) {
        const ledger = Number(lastEventDetails.ledger ?? 0);
        // We found a ProtocolPaused event!
        // 1. Disable transactional endpoints
        const reason = `Automated emergency pause: ProtocolPaused event detected in ledger ${ledger}`;
        await setLockdownState(true, { reason });
        
        // 2. Alert the ops team
        await notificationService.sendAlert({
          type: AlertType.KILL_SWITCH_TRIGGERED,
          severity: AlertSeverity.CRITICAL,
          title: "🚨 PROTOCOL PAUSED EVENT DETECTED",
          message: reason,
          details: {
            contract_id: contractId,
            ledger,
            tx_hash: lastEventDetails.txHash ?? lastEventDetails.id,
            action_taken: "Backend lockdown enabled. Transaction signing disabled."
          },
          timestamp: new Date(),
          service: "emergency-pause-listener"
        });
    }

    this.lastProcessedLedger = highestLedger;
  }

  stop(): void {
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.pollTimer = null;
    this.isRunning = false;
    logger.info("[EmergencyPauseListener] Stopped");
  }
}

export const emergencyPauseListener = new EmergencyPauseListener();
