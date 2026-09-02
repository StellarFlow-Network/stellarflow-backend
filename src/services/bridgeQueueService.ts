import prisma from "../lib/prisma";
import { logger } from "../utils/logger";
import { submitStagedMintTransaction } from "./bridgeMintingService";

export interface BridgeOperationParams {
  bridgeEventId: number;
  sorobanContract: string;
  mintAmount: string;
  recipientAddress: string;
  priority?: number;
}

export interface QueueStats {
  queued: number;
  processing: number;
  completed: number;
  failed: number;
}

/**
 * PostgreSQL-based queue for bridge operations
 * Uses the BridgeOperation model with priority-based processing
 */
export class BridgeQueueService {
  private isProcessing: boolean = false;
  private processingInterval: NodeJS.Timeout | null = null;
  private pollIntervalMs: number = 5000; // 5 seconds

  constructor(pollIntervalMs?: number) {
    if (pollIntervalMs) {
      this.pollIntervalMs = pollIntervalMs;
    }
  }

  /**
   * Enqueues a bridge operation for processing
   */
  async enqueue(params: BridgeOperationParams): Promise<string> {
    try {
      const bridgeOperation = await prisma.bridgeOperation.create({
        data: {
          bridgeEventId: params.bridgeEventId,
          sorobanContract: params.sorobanContract,
          mintAmount: params.mintAmount,
          recipientAddress: params.recipientAddress,
          queueStatus: "QUEUED",
          priority: params.priority || 5,
          retryCount: 0,
          maxRetries: 3,
          queuedAt: new Date(),
        },
      });

      logger.info(
        `[BridgeQueue] Enqueued operation ${bridgeOperation.id} for event ${params.bridgeEventId}`,
      );

      return bridgeOperation.id;
    } catch (error) {
      logger.error("[BridgeQueue] Failed to enqueue operation:", error);
      throw error;
    }
  }

  /**
   * Starts the queue processor
   */
  async start(): Promise<void> {
    if (this.isProcessing) {
      logger.warn("[BridgeQueue] Queue processor is already running");
      return;
    }

    this.isProcessing = true;
    logger.info("[BridgeQueue] Starting queue processor");

    // Start processing loop
    this.processingInterval = setInterval(() => {
      this.processQueue().catch((err) => {
        logger.error("[BridgeQueue] Processing error:", err);
      });
    }, this.pollIntervalMs);

    // Initial processing
    await this.processQueue();
  }

  /**
   * Stops the queue processor
   */
  stop(): void {
    if (this.processingInterval) {
      clearInterval(this.processingInterval);
      this.processingInterval = null;
    }
    this.isProcessing = false;
    logger.info("[BridgeQueue] Stopped queue processor");
  }

  /**
   * Processes queued bridge operations
   * Fetches operations by priority and submits them to Stellar
   */
  private async processQueue(): Promise<void> {
    try {
      // Get the next operation to process (priority-based)
      const operation = await prisma.bridgeOperation.findFirst({
        where: {
          queueStatus: "QUEUED",
          retryCount: { lt: 3 },
        },
        include: {
          bridgeEvent: true,
        },
        orderBy: [
          { priority: "asc" },
          { queuedAt: "asc" },
        ],
      });

      if (!operation) {
        return; // No operations to process
      }

      logger.info(
        `[BridgeQueue] Processing operation ${operation.id} (priority: ${operation.priority})`,
      );

      // Submit the staged transaction
      const txHash = await submitStagedMintTransaction(operation.id);

      if (txHash) {
        logger.info(`[BridgeQueue] Successfully processed operation ${operation.id}: ${txHash}`);
      } else {
        logger.error(`[BridgeQueue] Failed to process operation ${operation.id}`);
      }
    } catch (error) {
      logger.error("[BridgeQueue] Failed to process queue:", error);
    }
  }

  /**
   * Gets queue statistics
   */
  async getStats(): Promise<QueueStats> {
    const [queued, processing, completed, failed] = await Promise.all([
      prisma.bridgeOperation.count({ where: { queueStatus: "QUEUED" } }),
      prisma.bridgeOperation.count({ where: { queueStatus: "PROCESSING" } }),
      prisma.bridgeOperation.count({ where: { queueStatus: "COMPLETED" } }),
      prisma.bridgeOperation.count({ where: { queueStatus: "FAILED" } }),
    ]);

    return { queued, processing, completed, failed };
  }

  /**
   * Requeues failed operations that haven't exceeded max retries
   */
  async retryFailedOperations(): Promise<number> {
    const result = await prisma.bridgeOperation.updateMany({
      where: {
        queueStatus: "FAILED",
        retryCount: { lt: 3 },
      },
      data: {
        queueStatus: "QUEUED",
        retryCount: { increment: 1 },
      },
    });

    logger.info(`[BridgeQueue] Requeued ${result.count} failed operations`);
    return result.count;
  }

  /**
   * Gets pending operations for a specific bridge event
   */
  async getOperationsByEvent(bridgeEventId: number): Promise<any[]> {
    return prisma.bridgeOperation.findMany({
      where: { bridgeEventId },
      orderBy: { createdAt: "desc" },
    });
  }

  /**
   * Manually updates operation status (for admin/debug purposes)
   */
  async updateOperationStatus(
    operationId: string,
    status: "QUEUED" | "PROCESSING" | "COMPLETED" | "FAILED",
    errorMessage?: string,
  ): Promise<void> {
    await prisma.bridgeOperation.update({
      where: { id: operationId },
      data: {
        queueStatus: status,
        ...(errorMessage && { errorMessage }),
        ...(status === "PROCESSING" && { processingStartedAt: new Date() }),
        ...(status === "COMPLETED" && { completedAt: new Date() }),
      },
    });
  }

  /**
   * Cleans up old completed operations
   */
  async cleanupOldOperations(daysToKeep: number = 7): Promise<number> {
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - daysToKeep);

    const result = await prisma.bridgeOperation.deleteMany({
      where: {
        queueStatus: "COMPLETED",
        completedAt: { lt: cutoffDate },
      },
    });

    logger.info(`[BridgeQueue] Cleaned up ${result.count} old completed operations`);
    return result.count;
  }
}

let bridgeQueueServiceInstance: BridgeQueueService | null = null;

export function getBridgeQueueService(): BridgeQueueService {
  if (!bridgeQueueServiceInstance) {
    bridgeQueueServiceInstance = new BridgeQueueService();
  }
  return bridgeQueueServiceInstance;
}

/**
 * Convenience function to enqueue a bridge operation
 */
export async function enqueueBridgeOperation(params: BridgeOperationParams): Promise<string> {
  const service = getBridgeQueueService();
  return service.enqueue(params);
}
