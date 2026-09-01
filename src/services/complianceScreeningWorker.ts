import prisma from "../lib/prisma";
import {
  AlertSeverity,
  AlertType,
  NotificationService,
} from "./notificationService";
import {
  AnchorPayoutRelayService,
  PayoutHaltedError,
  anchorPayoutRelayService,
} from "./anchorPayoutRelayService";
import {
  ComplianceScreeningApiError,
  ComplianceScreeningClient,
  complianceScreeningClient,
} from "./complianceScreeningClient";
import { REMITTANCE_STATUS, type ScreeningHit } from "./complianceTypes";

const DEFAULT_BATCH_SIZE = 25;
const DEFAULT_INTERVAL_MS = 15_000;

type RemittanceRow = {
  id: string;
  senderPublicKey: string | null;
  recipientPublicKey: string | null;
  status: string;
  payoutHalted: boolean;
};

type RemittanceStore = {
  remittanceTransaction: {
    findMany: (args: unknown) => Promise<RemittanceRow[]>;
    update: (args: unknown) => Promise<unknown>;
  };
};

/**
 * Screens remittance sender/recipient Stellar public keys against a
 * third-party OFAC watchlist API and blocks anchor payout on a hit.
 */
export class ComplianceScreeningWorker {
  private timer: ReturnType<typeof setInterval> | undefined;
  private running = false;

  constructor(
    private readonly screening = complianceScreeningClient,
    private readonly payoutRelay = anchorPayoutRelayService,
    private readonly notifications = new NotificationService(),
    private readonly intervalMs = Number(
      process.env.COMPLIANCE_SCREENING_INTERVAL_MS ?? DEFAULT_INTERVAL_MS,
    ),
    private readonly batchSize = Number(
      process.env.COMPLIANCE_SCREENING_BATCH_SIZE ?? DEFAULT_BATCH_SIZE,
    ),
    private readonly db: RemittanceStore = prisma as unknown as RemittanceStore,
  ) {}

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.runOnce(), this.intervalMs);
    void this.runOnce();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  async runOnce(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      if (!this.screening.isConfigured()) {
        return;
      }

      const pending = await this.db.remittanceTransaction.findMany({
        where: { status: REMITTANCE_STATUS.PENDING_SCREENING },
        take: this.batchSize,
        orderBy: { createdAt: "asc" },
      });

      for (const tx of pending) {
        await this.screenTransaction(tx);
      }
    } finally {
      this.running = false;
    }
  }

  async screenTransaction(tx: RemittanceRow): Promise<void> {
    if (!tx.senderPublicKey || !tx.recipientPublicKey) {
      return;
    }

    await this.db.remittanceTransaction.update({
      where: { id: tx.id },
      data: { status: REMITTANCE_STATUS.SCREENING },
    });

    try {
      const [sender, recipient] = await Promise.all([
        this.screening.screenPublicKey(tx.senderPublicKey),
        this.screening.screenPublicKey(tx.recipientPublicKey),
      ]);

      const hits: ScreeningHit[] = [];
      if (sender.sanctioned) {
        hits.push({
          publicKey: sender.publicKey,
          role: "sender",
          sanctioned: true,
          provider: sender.provider,
          raw: sender.raw,
        });
      }
      if (recipient.sanctioned) {
        hits.push({
          publicKey: recipient.publicKey,
          role: "recipient",
          sanctioned: true,
          provider: recipient.provider,
          raw: recipient.raw,
        });
      }

      if (hits.length > 0) {
        await this.flagAndHalt(tx, hits);
        return;
      }

      await this.db.remittanceTransaction.update({
        where: { id: tx.id },
        data: {
          status: REMITTANCE_STATUS.COMPLIANCE_CLEARED,
          screeningProvider: sender.provider,
          screeningHits: [],
          screenedAt: new Date(),
          payoutHalted: false,
        },
      });

      await this.relayIfCleared({
        ...tx,
        status: REMITTANCE_STATUS.COMPLIANCE_CLEARED,
        payoutHalted: false,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const isScreeningFailure =
        error instanceof ComplianceScreeningApiError ||
        error instanceof PayoutHaltedError;

      await this.db.remittanceTransaction.update({
        where: { id: tx.id },
        data: {
          status: REMITTANCE_STATUS.PAYOUT_HALTED,
          payoutHalted: true,
          screeningHits: { error: message },
          screenedAt: new Date(),
        },
      });

      if (isScreeningFailure) {
        await this.notifications.sendAlert({
          type: AlertType.SECURITY_ALERT,
          severity: AlertSeverity.HIGH,
          title: "Remittance payout halted",
          message,
          service: "compliance-screening-worker",
          details: { remittanceId: tx.id },
          timestamp: new Date(),
        });
      }
    }
  }

  private async flagAndHalt(
    tx: RemittanceRow,
    hits: ScreeningHit[],
  ): Promise<void> {
    await this.db.remittanceTransaction.update({
      where: { id: tx.id },
      data: {
        status: REMITTANCE_STATUS.FLAGGED_COMPLIANCE,
        screeningHits: hits,
        screeningProvider: hits[0]?.provider,
        screenedAt: new Date(),
        payoutHalted: true,
      },
    });

    await this.notifications.sendAlert({
      type: AlertType.SECURITY_ALERT,
      severity: AlertSeverity.CRITICAL,
      title: "Remittance flagged for compliance",
      message: `Sender or recipient matched a sanctions/OFAC watchlist for remittance ${tx.id}`,
      service: "compliance-screening-worker",
      details: {
        remittanceId: tx.id,
        senderPublicKey: tx.senderPublicKey,
        recipientPublicKey: tx.recipientPublicKey,
        hits,
      },
      timestamp: new Date(),
    });
  }

  private async relayIfCleared(tx: RemittanceRow): Promise<void> {
    if (!tx.senderPublicKey || !tx.recipientPublicKey) {
      return;
    }
    await this.payoutRelay.relay({
      ...tx,
      senderPublicKey: tx.senderPublicKey,
      recipientPublicKey: tx.recipientPublicKey,
    });
    await this.db.remittanceTransaction.update({
      where: { id: tx.id },
      data: {
        status: REMITTANCE_STATUS.PAYOUT_RELAYED,
        payoutRelayedAt: new Date(),
      },
    });
  }
}

export const complianceScreeningWorker = new ComplianceScreeningWorker();

export function createComplianceScreeningWorker(deps: {
  screening?: ComplianceScreeningClient;
  payoutRelay?: AnchorPayoutRelayService;
  notifications?: NotificationService;
  intervalMs?: number;
  batchSize?: number;
  db?: RemittanceStore;
}): ComplianceScreeningWorker {
  return new ComplianceScreeningWorker(
    deps.screening ?? complianceScreeningClient,
    deps.payoutRelay ?? anchorPayoutRelayService,
    deps.notifications ?? new NotificationService(),
    deps.intervalMs ??
      Number(
        process.env.COMPLIANCE_SCREENING_INTERVAL_MS ?? DEFAULT_INTERVAL_MS,
      ),
    deps.batchSize ??
      Number(process.env.COMPLIANCE_SCREENING_BATCH_SIZE ?? DEFAULT_BATCH_SIZE),
    deps.db ?? (prisma as unknown as RemittanceStore),
  );
}
