/**
 * DisputeService – Issue #834
 *
 * Manages dispute-ticket state machines opened when fiat payouts fail or time
 * out.
 *
 * State machine
 * -------------
 *   open --> investigating -> refunded / closed
 *   open --> refunded
 *   open --> closed
 *   refunded --> closed
 *
 * Every state change dispatches email and webhook updates to the affected
 * user, so tickets stay observable both through the user's inbox and through
 * any webhook endpoint registered on the ticket.
 *
 * Email dispatch is delegated to `EmailService` (HTTP email API when
 * configured, logged-and-skipped otherwise).  Webhook updates are POSTed to
 * `webhookUrl` with the full dispute snapshot.
 */

import prisma from "../lib/prisma";
import { httpClient } from "../lib/httpClient.js";
import { withRetry } from "../utils/retryUtil.js";
import { OUTGOING_HTTP_TIMEOUT_MS } from "../utils/httpTimeout.js";
import { emailService, EmailMessage } from "./emailService";

// ---------------------------------------------------------------------------
// Constants & types
// ---------------------------------------------------------------------------

export const DISPUTE_STATUSES = [
  "open",
  "investigating",
  "refunded",
  "closed",
] as const;

export type DisputeStatus = (typeof DISPUTE_STATUSES)[number];

/** Valid state transitions for the dispute ticket state machine. */
export const DISPUTE_TRANSITIONS: Record<DisputeStatus, DisputeStatus[]> = {
  open: ["investigating", "refunded", "closed"],
  investigating: ["refunded", "closed"],
  refunded: ["closed"],
  closed: [],
};

export interface OpenDisputeInput {
  remittanceId: string;
  userId: string;
  reason: string;
  details?: unknown;
  email?: string;
  webhookUrl?: string;
}

export interface TransitionDisputeInput {
  toStatus: DisputeStatus;
  byId?: string;
  email?: string;
  webhookUrl?: string;
}

export interface ManualRefundInput {
  refundAmount?: number;
  byId?: string;
  email?: string;
  webhookUrl?: string;
}

export interface DisputeListFilters {
  status?: DisputeStatus;
  userId?: string;
  limit?: number;
  offset?: number;
}

/** Public-shaped dispute ticket returned by the service. */
export interface DisputeRecord {
  id: string;
  remittanceId: string;
  userId: string;
  status: DisputeStatus;
  reason: string;
  details: string | null;
  email: string | null;
  webhookUrl: string | null;
  refundAmount: number | null;
  refundedById: string | null;
  refundedAt: string | null;
  resolvedById: string | null;
  resolvedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface DisputeResult {
  success: boolean;
  dispute?: DisputeRecord;
  error?: string;
}

export interface DisputeListResult {
  success: boolean;
  data?: DisputeRecord[];
  total?: number;
  error?: string;
}

interface DisputeRow {
  id: string;
  remittanceId: string;
  userId: string;
  status: string;
  reason: string;
  details: string | null;
  email: string | null;
  webhookUrl: string | null;
  refundAmount: { valueOf(): number } | number | null;
  refundedById: string | null;
  refundedAt: Date | null;
  resolvedById: string | null;
  resolvedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

const STATUS_MESSAGES: Record<
  DisputeStatus,
  { subject: string; message: string }
> = {
  open: {
    subject: "Dispute opened for your remittance",
    message:
      "A dispute has been opened for your remittance transaction because the fiat payout failed or timed out. Our team is reviewing the ticket.",
  },
  investigating: {
    subject: "Your remittance dispute is under investigation",
    message:
      "Your remittance dispute is now being investigated. We will notify you as soon as an update is available.",
  },
  refunded: {
    subject: "Refund issued for your remittance dispute",
    message:
      "A refund has been issued for your remittance dispute. The funds are being returned to your account.",
  },
  closed: {
    subject: "Your remittance dispute has been closed",
    message:
      "Your remittance dispute has been closed. If you have further questions, please contact support.",
  },
};

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Dispute service failure";
}

function toDisputeRecord(row: DisputeRow): DisputeRecord {
  const status = DISPUTE_STATUSES.includes(row.status as DisputeStatus)
    ? (row.status as DisputeStatus)
    : "open";

  return {
    id: row.id,
    remittanceId: row.remittanceId,
    userId: row.userId,
    status,
    reason: row.reason,
    details: row.details ?? null,
    email: row.email ?? null,
    webhookUrl: row.webhookUrl ?? null,
    refundAmount:
      row.refundAmount !== null ? Number(row.refundAmount) : null,
    refundedById: row.refundedById ?? null,
    refundedAt: row.refundedAt?.toISOString() ?? null,
    resolvedById: row.resolvedById ?? null,
    resolvedAt: row.resolvedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Service class
// ---------------------------------------------------------------------------

export class DisputeService {
  /**
   * Open a new dispute ticket (status `open`) for a remittance transaction
   * whose fiat payout failed or timed out.  Dispatch of the `open`
   * notification is best-effort; a notification failure never fails the open.
   */
  async openDispute(input: OpenDisputeInput): Promise<DisputeResult> {
    try {
      const { remittanceId, userId, reason, details, email, webhookUrl } =
        input;

      if (!remittanceId || !userId || !reason) {
        return {
          success: false,
          error: "remittanceId, userId and reason are required",
        };
      }

      const created = await prisma.remittanceDispute.create({
        data: {
          remittanceId,
          userId,
          status: "open",
          reason,
          details: details !== undefined ? JSON.stringify(details) : null,
          email: email ?? null,
          webhookUrl: webhookUrl ?? null,
        },
      });

      const record = toDisputeRecord(created as unknown as DisputeRow);
      await this.notifyStateChange(record);

      return { success: true, dispute: record };
    } catch (error) {
      return { success: false, error: errorMessage(error) };
    }
  }

  /** Fetch a list of dispute tickets (admin tracking / review). */
  async listDisputes(
    filters: DisputeListFilters = {},
  ): Promise<DisputeListResult> {
    try {
      const limit = Math.min(
        Math.max(Number(filters.limit ?? 50), 1),
        200,
      );

      const where: {
        status?: DisputeStatus;
        userId?: string;
      } = {};
      if (filters.status) where.status = filters.status;
      if (filters.userId) where.userId = filters.userId;

      const [rows, total] = await Promise.all([
        prisma.remittanceDispute.findMany({
          where,
          orderBy: [{ createdAt: "desc" }, { id: "asc" }],
          take: limit,
          skip: filters.offset ?? 0,
        }),
        prisma.remittanceDispute.count({ where }),
      ]);

      return {
        success: true,
        data: rows.map((row) =>
          toDisputeRecord(row as unknown as DisputeRow),
        ),
        total,
      };
    } catch (error) {
      return { success: false, error: errorMessage(error) };
    }
  }

  /** Fetch a single dispute ticket. */
  async getDispute(disputeId: string): Promise<DisputeResult> {
    try {
      const row = await prisma.remittanceDispute.findUnique({
        where: { id: disputeId },
      });

      if (!row) {
        return { success: false, error: "Dispute ticket not found" };
      }

      return {
        success: true,
        dispute: toDisputeRecord(row as unknown as DisputeRow),
      };
    } catch (error) {
      return { success: false, error: errorMessage(error) };
    }
  }

  /**
   * Advance a dispute ticket through its state machine.  Invalid transitions
   * are rejected without touching the database.  A state change dispatches the
   * email + webhook update for the new status.
   */
  async transitionStatus(
    disputeId: string,
    input: TransitionDisputeInput,
  ): Promise<DisputeResult> {
    try {
      const existing = await prisma.remittanceDispute.findUnique({
        where: { id: disputeId },
      });

      if (!existing) {
        return { success: false, error: "Dispute ticket not found" };
      }

      if (!DISPUTE_STATUSES.includes(input.toStatus)) {
        return {
          success: false,
          error: `Invalid target status. Must be one of: ${DISPUTE_STATUSES.join(", ")}`,
        };
      }

      const current = existing.status as DisputeStatus;
      const allowed = DISPUTE_TRANSITIONS[current] ?? [];
      if (!allowed.includes(input.toStatus)) {
        return {
          success: false,
          error: `Cannot transition dispute from '${current}' to '${input.toStatus}'`,
        };
      }

      const updated = await prisma.remittanceDispute.update({
        where: { id: disputeId },
        data: {
          status: input.toStatus,
          ...(input.toStatus === "closed"
            ? { resolvedById: input.byId ?? null, resolvedAt: new Date() }
            : {}),
          ...(input.email !== undefined ? { email: input.email } : {}),
          ...(input.webhookUrl !== undefined
            ? { webhookUrl: input.webhookUrl }
            : {}),
        },
      });

      const record = toDisputeRecord(updated as unknown as DisputeRow);
      await this.notifyStateChange(record);

      return { success: true, dispute: record };
    } catch (error) {
      return { success: false, error: errorMessage(error) };
    }
  }

  /**
   * Admin endpoint backing action: allow an operator to trigger a manual
   * refund.  Moves the ticket to `refunded`, records the refund metadata and
   * dispatches the notification for the new status.
   */
  async triggerManualRefund(
    disputeId: string,
    input: ManualRefundInput,
  ): Promise<DisputeResult> {
    try {
      const existing = await prisma.remittanceDispute.findUnique({
        where: { id: disputeId },
      });

      if (!existing) {
        return { success: false, error: "Dispute ticket not found" };
      }

      if (existing.status === "closed") {
        return {
          success: false,
          error: "Cannot refund a dispute that has already been closed",
        };
      }

      const updated = await prisma.remittanceDispute.update({
        where: { id: disputeId },
        data: {
          status: "refunded",
          refundAmount:
            input.refundAmount !== undefined ? input.refundAmount : null,
          refundedById: input.byId ?? null,
          refundedAt: new Date(),
          ...(input.email !== undefined ? { email: input.email } : {}),
          ...(input.webhookUrl !== undefined
            ? { webhookUrl: input.webhookUrl }
            : {}),
        },
      });

      const record = toDisputeRecord(updated as unknown as DisputeRow);
      await this.notifyStateChange(record);

      return { success: true, dispute: record };
    } catch (error) {
      return { success: false, error: errorMessage(error) };
    }
  }

  // -------------------------------------------------------------------------
  // Notification dispatch
  // -------------------------------------------------------------------------

  /**
   * Dispatch email + webhook updates for the ticket's current state.
   *
   * Best-effort: dispatch failures are logged but never thrown, so an
   * unavailable email provider or webhook endpoint cannot fail the underlying
   * dispute operation.
   */
  async notifyStateChange(dispute: DisputeRecord): Promise<void> {
    try {
      const meta = STATUS_MESSAGES[dispute.status];

      if (dispute.email) {
        const message: EmailMessage = {
          to: dispute.email,
          subject: meta.subject,
          text:
            `${meta.message}\n\n` +
            `Dispute ID: ${dispute.id}\n` +
            `Transaction ID: ${dispute.remittanceId}\n` +
            `Status: ${dispute.status}\n` +
            `Reason: ${dispute.reason}\n\n` +
            `Thank you,\nStellarFlow Support`,
        };
        await emailService.send(message);
      }

      if (dispute.webhookUrl) {
        await this.dispatchWebhook(dispute);
      }
    } catch (error) {
      console.error(
        "[DisputeService] Dispute notification dispatch failed:",
        error instanceof Error ? error.message : error,
      );
    }
  }

  /** POST the dispute snapshot to the ticket's webhook endpoint. */
  private async dispatchWebhook(dispute: DisputeRecord): Promise<void> {
    await withRetry(
      () =>
        httpClient.post(
          dispute.webhookUrl!,
          {
            eventType: "dispute.state_changed",
            timestamp: new Date().toISOString(),
            data: { dispute },
          },
          {
            headers: { "Content-Type": "application/json" },
            timeout: OUTGOING_HTTP_TIMEOUT_MS,
          },
        ),
      {
        maxRetries: 3,
        retryDelay: 1000,
        onRetry: (attempt, error, delay) => {
          console.debug(
            `[DisputeService] Webhook retry attempt ${attempt} after ${delay}ms. Error: ${error.message}`,
          );
        },
      },
    );
  }
}

export const disputeService = new DisputeService();
export default disputeService;