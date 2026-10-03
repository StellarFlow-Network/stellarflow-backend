/**
 * Settlement Latency Monitor Service
 *
 * Deliverables:
 * 1. Track mean time to settlement T_settlement per corridor (e.g. USD -> NGN, EUR -> KES).
 * 2. Deactivate underperforming anchors automatically if T_settlement > 4 hours (14,400 seconds).
 * 3. Re-route pending remittance traffic to backup corridor partners.
 */

import prisma from "../lib/prisma.js";

export const DEFAULT_SLA_THRESHOLD_SECONDS = 4 * 3600; // 14,400 seconds = 4 hours

export interface CorridorMetrics {
  corridor: string;
  senderCurrency: string;
  receiverCurrency: string;
  meanSettlementSeconds: number;
  meanSettlementHours: number;
  sampleCount: number;
  activeAnchors: string[];
  deactivatedAnchors: string[];
  isSlaViolated: boolean;
}

export interface AnchorLatencyMetric {
  anchorId: string;
  corridor: string;
  senderCurrency: string;
  receiverCurrency: string;
  sampleCount: number;
  meanSettlementSeconds: number;
  meanSettlementHours: number;
  slaLimitSeconds: number;
  isSlaViolated: boolean;
  activePendingCount: number;
}

export interface RerouteItem {
  transactionId: string;
  previousAnchor: string;
  newAnchor: string;
  corridor: string;
}

export interface EvaluationCycleResult {
  evaluatedCorridors: number;
  evaluatedAnchors: number;
  deactivatedAnchors: string[];
  reroutedTransactions: RerouteItem[];
  unroutableTransactions: string[];
}

export class SettlementLatencyMonitorService {
  constructor(
    private readonly slaThresholdSeconds: number = DEFAULT_SLA_THRESHOLD_SECONDS,
    private readonly minSamplesForDeactivation: number = 1,
  ) {}

  /**
   * Calculates the mean time to settlement T_settlement for a given anchor within a corridor.
   */
  async calculateAnchorSettlementLatency(
    anchorId: string,
    senderCurrency: string,
    receiverCurrency: string,
    lookbackHours: number = 24,
  ): Promise<AnchorLatencyMetric> {
    const sender = senderCurrency.toUpperCase();
    const receiver = receiverCurrency.toUpperCase();
    const corridor = `${sender} -> ${receiver}`;

    const cutoff = new Date(Date.now() - lookbackHours * 3600 * 1000);

    // Fetch settled transactions
    const completedTransactions = await prisma.remittanceTransaction.findMany({
      where: {
        provider: anchorId,
        senderCurrency: sender,
        receiverCurrency: receiver,
        status: { in: ["COMPLETED", "SETTLED", "SUCCESS", "DELIVERED"] },
        createdAt: { gte: cutoff },
      },
      select: {
        id: true,
        createdAt: true,
        updatedAt: true,
      },
    });

    const pendingCount = await prisma.remittanceTransaction.count({
      where: {
        provider: anchorId,
        senderCurrency: sender,
        receiverCurrency: receiver,
        status: {
          in: [
            "PENDING",
            "pending_external",
            "pending_user_transfer",
            "screening",
            "compliance_cleared",
            "payout_relayed",
            "QUEUED",
            "PROCESSING",
          ],
        },
      },
    });

    if (completedTransactions.length === 0) {
      return {
        anchorId,
        corridor,
        senderCurrency: sender,
        receiverCurrency: receiver,
        sampleCount: 0,
        meanSettlementSeconds: 0,
        meanSettlementHours: 0,
        slaLimitSeconds: this.slaThresholdSeconds,
        isSlaViolated: false,
        activePendingCount: pendingCount,
      };
    }

    const totalDurationSeconds = completedTransactions.reduce((acc, tx) => {
      const duration = (tx.updatedAt.getTime() - tx.createdAt.getTime()) / 1000;
      return acc + Math.max(0, duration);
    }, 0);

    const meanSeconds = totalDurationSeconds / completedTransactions.length;
    const isSlaViolated =
      completedTransactions.length >= this.minSamplesForDeactivation &&
      meanSeconds > this.slaThresholdSeconds;

    return {
      anchorId,
      corridor,
      senderCurrency: sender,
      receiverCurrency: receiver,
      sampleCount: completedTransactions.length,
      meanSettlementSeconds: meanSeconds,
      meanSettlementHours: meanSeconds / 3600,
      slaLimitSeconds: this.slaThresholdSeconds,
      isSlaViolated,
      activePendingCount: pendingCount,
    };
  }

  /**
   * Finds the best active backup corridor partner for re-routing.
   */
  async findBackupPartner(
    senderCurrency: string,
    receiverCurrency: string,
    excludedAnchor: string,
  ): Promise<string | null> {
    const sender = senderCurrency.toUpperCase();
    const receiver = receiverCurrency.toUpperCase();

    const activeRoutes = await prisma.paymentRoute.findMany({
      where: {
        senderCurrency: sender,
        receiverCurrency: receiver,
        status: "ACTIVE",
        provider: { not: excludedAnchor },
      },
      orderBy: [{ priority: "desc" }, { rate: "desc" }],
    });

    if (activeRoutes.length === 0) {
      return null;
    }

    return activeRoutes[0].provider;
  }

  /**
   * Re-routes all pending remittance traffic for an underperforming anchor to a backup partner.
   */
  async reroutePendingRemittances(
    deactivatedAnchor: string,
    senderCurrency: string,
    receiverCurrency: string,
    backupAnchor: string,
  ): Promise<RerouteItem[]> {
    const sender = senderCurrency.toUpperCase();
    const receiver = receiverCurrency.toUpperCase();
    const corridor = `${sender} -> ${receiver}`;

    const pendingTransactions = await prisma.remittanceTransaction.findMany({
      where: {
        provider: deactivatedAnchor,
        senderCurrency: sender,
        receiverCurrency: receiver,
        status: {
          in: [
            "PENDING",
            "pending_external",
            "pending_user_transfer",
            "screening",
            "compliance_cleared",
            "payout_relayed",
            "QUEUED",
            "PROCESSING",
          ],
        },
      },
      select: { id: true },
    });

    const reroutedItems: RerouteItem[] = [];

    for (const tx of pendingTransactions) {
      await prisma.remittanceTransaction.update({
        where: { id: tx.id },
        data: {
          provider: backupAnchor,
          updatedAt: new Date(),
        },
      });

      reroutedItems.push({
        transactionId: tx.id,
        previousAnchor: deactivatedAnchor,
        newAnchor: backupAnchor,
        corridor,
      });
    }

    return reroutedItems;
  }

  /**
   * Runs automated monitoring across all corridors:
   * 1. Evaluates T_settlement per anchor and corridor.
   * 2. Deactivates underperforming anchors automatically if T_settlement > 4 hours.
   * 3. Re-routes pending remittance traffic to backup corridor partners.
   */
  async evaluateAndFailover(lookbackHours: number = 24): Promise<EvaluationCycleResult> {
    const distinctPairs = await prisma.paymentRoute.findMany({
      select: {
        senderCurrency: true,
        receiverCurrency: true,
        provider: true,
      },
      distinct: ["senderCurrency", "receiverCurrency", "provider"],
    });

    const deactivatedAnchors: string[] = [];
    const reroutedTransactions: RerouteItem[] = [];
    const unroutableTransactions: string[] = [];

    for (const pair of distinctPairs) {
      const metric = await this.calculateAnchorSettlementLatency(
        pair.provider,
        pair.senderCurrency,
        pair.receiverCurrency,
        lookbackHours,
      );

      if (metric.isSlaViolated) {
        // Deactivate underperforming anchor in PaymentRoute
        await prisma.paymentRoute.updateMany({
          where: {
            provider: pair.provider,
            senderCurrency: pair.senderCurrency,
            receiverCurrency: pair.receiverCurrency,
            status: "ACTIVE",
          },
          data: {
            status: "PAUSED",
            updatedAt: new Date(),
          },
        });

        deactivatedAnchors.push(`${pair.provider} (${metric.corridor})`);

        // Find backup corridor partner
        const backup = await this.findBackupPartner(
          pair.senderCurrency,
          pair.receiverCurrency,
          pair.provider,
        );

        if (backup) {
          const rerouted = await this.reroutePendingRemittances(
            pair.provider,
            pair.senderCurrency,
            pair.receiverCurrency,
            backup,
          );
          reroutedTransactions.push(...rerouted);
        } else {
          // No backup partner found
          const pending = await prisma.remittanceTransaction.findMany({
            where: {
              provider: pair.provider,
              senderCurrency: pair.senderCurrency,
              receiverCurrency: pair.receiverCurrency,
              status: {
                in: [
                  "PENDING",
                  "pending_external",
                  "pending_user_transfer",
                  "screening",
                  "compliance_cleared",
                  "payout_relayed",
                ],
              },
            },
            select: { id: true },
          });
          unroutableTransactions.push(...pending.map((p) => p.id));
        }
      }
    }

    return {
      evaluatedCorridors: new Set(
        distinctPairs.map((p) => `${p.senderCurrency}->${p.receiverCurrency}`),
      ).size,
      evaluatedAnchors: distinctPairs.length,
      deactivatedAnchors,
      reroutedTransactions,
      unroutableTransactions,
    };
  }
}

export const settlementLatencyMonitorService = new SettlementLatencyMonitorService();
