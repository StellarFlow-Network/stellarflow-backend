/**
 * Anchor Webhook Service – Issue #931
 *
 * Processes incoming webhook status updates from Stellar anchor partners.
 * Validates HMAC-SHA256 signatures and transitions RemittanceTransaction
 * status through the state machine (e.g., pending_user_transfer -> COMPLETED).
 *
 * SEP-24 / SEP-31 Compliance
 * ----------------------------
 * Supports status webhook payloads from Stellar Financial Partners following:
 * - SEP-24: Hosted Deposit and Withdrawal standard
 * - SEP-31: Cross-Border Payments RFQ-based Anchored Asset Transfers
 *
 * Expected payload structure:
 * {
 *   "transaction": {
 *     "id": "<transaction-id>",
 *     "status": "<status>",
 *     ...
 *   }
 * }
 */

import crypto from "crypto";
import prisma from "../lib/prisma";
import { createFetcherLogger } from "../utils/logger";

export interface AnchorWebhookPayload {
  transaction?: {
    id?: unknown;
    status?: unknown;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

export interface AnchorStatusUpdateResult {
  success: boolean;
  transactionId?: string;
  previousStatus?: string;
  newStatus?: string;
  message?: string;
  error?: string;
}

// Valid states that trigger completion
const COMPLETED_STATUSES = new Set([
  "completed",
  "complete",
  "delivered",
  "settled",
  "success",
  "dispatched",
]);

// States from which we can transition to COMPLETED
const TRANSITIONABLE_FROM_STATES = new Set([
  "PENDING",
  "pending_user_transfer",
  "payout_relayed",
  "screening",
  "compliance_cleared",
  "flagged_compliance",
]);

export class AnchorWebhookService {
  private readonly logger = createFetcherLogger("AnchorWebhookService");

  /**
   * Validates an HMAC-SHA256 signature against a payload.
   * Uses constant-time comparison to prevent timing attacks.
   */
  validateSignature(
    payload: Buffer,
    signature: string | undefined,
    secret: string,
  ): boolean {
    if (!signature) {
      this.logger.warn("Missing X-Anchor-Signature header");
      return false;
    }

    if (!secret || secret.length === 0) {
      this.logger.error("ANCHOR_WEBHOOK_SECRET is not configured");
      return false;
    }

    try {
      const secretBuffer = Buffer.from(secret);
      const expectedHmac = crypto
        .createHmac("sha256", secretBuffer)
        .update(payload)
        .digest("hex");

      // Constant-time comparison prevents timing attacks
      return crypto.timingSafeEqual(
        Buffer.from(expectedHmac),
        Buffer.from(signature),
      );
    } catch (error) {
      this.logger.error("HMAC validation error", {
        error: error instanceof Error ? error.message : String(error),
      });
      return false;
    }
  }

  /**
   * Extracts and validates transaction ID and status from webhook payload.
   */
  private extractTransactionInfo(
    payload: AnchorWebhookPayload,
  ): { transactionId?: string; status?: string; error?: string } {
    const transaction = payload.transaction;

    if (!transaction || typeof transaction !== "object") {
      return {
        error: "Missing or invalid 'transaction' field in payload",
      };
    }

    const transactionId = String(transaction.id ?? "").trim();
    if (!transactionId) {
      return { error: "Missing or empty 'transaction.id' field" };
    }

    const rawStatus = String(transaction.status ?? "").trim();
    if (!rawStatus) {
      return { error: "Missing or empty 'transaction.status' field" };
    }

    const status = rawStatus.toLowerCase();

    return { transactionId, status };
  }

  /**
   * Normalizes a status string to the RemittanceTransaction model's status values.
   * Maps SEP-24/SEP-31 status strings to internal state machine states.
   */
  private normalizeStatus(anchorStatus: string): string {
    const normalized = anchorStatus.toLowerCase();

    if (COMPLETED_STATUSES.has(normalized)) {
      return "COMPLETED";
    }

    // Pass through known internal statuses
    const upperStatus = anchorStatus.toUpperCase();
    if (
      [
        "PENDING",
        "FAILED",
        "REVERSED",
        "pending_screening",
        "screening",
        "flagged_compliance",
        "compliance_cleared",
        "payout_relayed",
        "payout_halted",
      ].includes(upperStatus)
    ) {
      return upperStatus;
    }

    // Default: return COMPLETED if recognized as success-like status
    if (COMPLETED_STATUSES.has(normalized)) {
      return "COMPLETED";
    }

    // Fallback: return normalized uppercase
    return upperStatus;
  }

  /**
   * Transitions a RemittanceTransaction to a new status.
   * Only transitions if the current status allows it.
   * Returns null if the transition was not applied (e.g., already in final state).
   */
  private async transitionTransactionStatus(
    transactionId: string,
    newStatus: string,
  ): Promise<{ previousStatus: string; updated: boolean } | null> {
    try {
      // Find the current transaction
      const transaction = await prisma.remittanceTransaction.findUnique({
        where: { id: transactionId },
        select: { id: true, status: true, userId: true },
      });

      if (!transaction) {
        this.logger.warn("Transaction not found", { transactionId });
        return null;
      }

      const currentStatus = transaction.status;

      // Only transition if the new status is different and is allowed
      if (currentStatus === newStatus) {
        this.logger.info("Status unchanged", {
          transactionId,
          status: currentStatus,
        });
        return { previousStatus: currentStatus, updated: false };
      }

      // Ensure we can transition to the new status
      if (newStatus === "COMPLETED" && !TRANSITIONABLE_FROM_STATES.has(currentStatus)) {
        this.logger.warn("Cannot transition to COMPLETED from current state", {
          transactionId,
          currentStatus,
          newStatus,
        });
        return { previousStatus: currentStatus, updated: false };
      }

      // Update the transaction status
      const updated = await prisma.remittanceTransaction.update({
        where: { id: transactionId },
        data: {
          status: newStatus,
          updatedAt: new Date(),
        },
        select: { id: true, status: true },
      });

      this.logger.info("Transaction status transitioned", {
        transactionId,
        previousStatus: currentStatus,
        newStatus: updated.status,
      });

      return { previousStatus: currentStatus, updated: true };
    } catch (error) {
      this.logger.error("Failed to transition transaction status", {
        transactionId,
        newStatus,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  /**
   * Processes an incoming anchor webhook payload.
   * Validates payload structure, extracts transaction info, and updates state machine.
   */
  async processWebhook(
    payload: unknown,
    signature: string | undefined,
    secret: string,
  ): Promise<AnchorStatusUpdateResult> {
    // Validate payload is an object
    if (!payload || typeof payload !== "object") {
      return {
        success: false,
        error: "Invalid JSON payload: expected an object",
      };
    }

    // Extract transaction info
    const { transactionId, status: rawStatus, error: extractError } =
      this.extractTransactionInfo(payload as AnchorWebhookPayload);

    if (extractError) {
      return { success: false, error: extractError };
    }

    if (!transactionId || !rawStatus) {
      return {
        success: false,
        error: "Could not extract transaction ID and status",
      };
    }

    // Normalize the status to our internal state machine
    const newStatus = this.normalizeStatus(rawStatus);

    // Attempt the state transition
    try {
      const result = await this.transitionTransactionStatus(
        transactionId,
        newStatus,
      );

      if (!result) {
        return {
          success: false,
          transactionId,
          error: "Transaction not found in database",
        };
      }

      if (!result.updated) {
        // Status was unchanged or transition not allowed
        return {
          success: true,
          transactionId,
          previousStatus: result.previousStatus,
          newStatus,
          message: `Status update not applied: transaction already in status '${result.previousStatus}'`,
        };
      }

      return {
        success: true,
        transactionId,
        previousStatus: result.previousStatus,
        newStatus,
        message: "Transaction status updated successfully",
      };
    } catch (error) {
      return {
        success: false,
        transactionId,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }
}

export const anchorWebhookService = new AnchorWebhookService();
