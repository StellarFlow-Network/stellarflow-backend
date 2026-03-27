import { multiSigService } from "./multiSigService";
import { StellarService } from "./stellarService";
import { priceReviewService } from "./priceReviewService";
import prisma from "../lib/prisma";
import dotenv from "dotenv";

dotenv.config();

/**
 * MultiSigSubmissionService
 * Handles the automatic submission of approved multi-sig prices to Stellar.
 * Runs as a background job/scheduler.
 */
export class MultiSigSubmissionService {
  private stellarService: StellarService;
  private pollIntervalMs: number;
  private isRunning: boolean = false;
  private pollTimer: ReturnType<typeof setInterval> | null = null;

  constructor(pollIntervalMs: number = 30000) {
    this.stellarService = new StellarService();
    this.pollIntervalMs = pollIntervalMs;
  }

  /**
   * Start the background submission service.
   * This will periodically check for approved multi-sig prices and submit them to Stellar.
   */
  async start(): Promise<void> {
    if (this.isRunning) {
      console.warn(
        "[MultiSigSubmissionService] Service is already running"
      );
      return;
    }

    this.isRunning = true;
    console.info(
      `[MultiSigSubmissionService] Started with ${this.pollIntervalMs}ms poll interval`
    );

    // Initial check
    await this.checkAndSubmitApprovedPrices();

    // Start periodic polling
    this.pollTimer = setInterval(() => {
      this.checkAndSubmitApprovedPrices().catch((err) => {
        console.error(
          "[MultiSigSubmissionService] Polling error:",
          err
        );
      });
    }, this.pollIntervalMs);
  }

  /**
   * Stop the background submission service.
   */
  stop(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    this.isRunning = false;
    console.info("[MultiSigSubmissionService] Stopped");
  }

  /**
   * Check for approved multi-sig prices and submit them to Stellar.
   * This is the main polling function.
   */
  private async checkAndSubmitApprovedPrices(): Promise<void> {
    try {
      // Find all approved multi-sig prices that haven't been submitted yet
      const approvedPrices = await prisma.multiSigPrice.findMany({
        where: {
          status: "APPROVED",
          submittedAt: null, // Not yet submitted to Stellar
        },
        include: {
          multiSigSignatures: {
            select: {
              signature: true,
              signerPublicKey: true,
            },
          },
        },
      });

      if (approvedPrices.length === 0) {
        return; // Nothing to do
      }

      console.info(
        `[MultiSigSubmissionService] Found ${approvedPrices.length} approved prices to submit`
      );

      // Process each approved price
      for (const multiSigPrice of approvedPrices) {
        try {
          await this.submitApprovedPrice(multiSigPrice);
        } catch (error) {
          console.error(
            `[MultiSigSubmissionService] Failed to submit multi-sig price ${multiSigPrice.id}:`,
            error
          );
          // Continue with next price, don't let one failure block others
        }
      }
    } catch (error) {
      console.error(
        "[MultiSigSubmissionService] Error checking approved prices:",
        error
      );
    }
  }

  /**
   * Submit a single approved multi-sig price to Stellar.
   */
  private async submitApprovedPrice(multiSigPrice: any): Promise<void> {
    try {
      // Prepare signatures for submission
      const signatures = multiSigPrice.multiSigSignatures.map((sig: any) => ({
        signerPublicKey: sig.signerPublicKey,
        signature: sig.signature,
      }));

      if (signatures.length === 0) {
        console.warn(
          `[MultiSigSubmissionService] No signatures found for multi-sig price ${multiSigPrice.id}`
        );
        return;
      }

      console.info(
        `[MultiSigSubmissionService] Submitting multi-sig price ${multiSigPrice.id} (${multiSigPrice.currency} @ ${multiSigPrice.rate}) with ${signatures.length} signatures`
      );

      // Submit to Stellar with multiple signatures
      const memoId = multiSigPrice.memoId || `MS-${multiSigPrice.id}`;
      const txHash = await this.stellarService.submitMultiSignedPriceUpdate(
        multiSigPrice.currency,
        multiSigPrice.rate.toNumber(),
        memoId,
        signatures
      );

      // Record the submission
      await multiSigService.recordSubmission(
        multiSigPrice.id,
        memoId,
        txHash
      );

      // Mark the associated price review as submitted
      await priceReviewService.markContractSubmitted(
        multiSigPrice.priceReviewId,
        memoId,
        txHash
      );

      console.info(
        `[MultiSigSubmissionService] ✅ Successfully submitted multi-sig price ${multiSigPrice.id} - TxHash: ${txHash}`
      );
    } catch (error) {
      console.error(
        `[MultiSigSubmissionService] Error submitting multi-sig price ${multiSigPrice.id}:`,
        error
      );
      throw error;
    }
  }

  /**
   * Cleanup expired multi-sig requests.
   * Can be called manually or as part of a scheduled maintenance task.
   */
  async cleanupExpired(): Promise<number> {
    try {
      const count = await multiSigService.cleanupExpiredRequests();
      if (count > 0) {
        console.info(
          `[MultiSigSubmissionService] Cleaned up ${count} expired multi-sig requests`
        );
      }
      return count;
    } catch (error) {
      console.error(
        "[MultiSigSubmissionService] Error during cleanup:",
        error
      );
      return 0;
    }
  }

  /**
   * Get status of the background service.
   */
  getStatus(): {
    isRunning: boolean;
    pollIntervalMs: number;
  } {
    return {
      isRunning: this.isRunning,
      pollIntervalMs: this.pollIntervalMs,
    };
  }
}

// Export singleton instance
export const multiSigSubmissionService = new MultiSigSubmissionService();
