import prisma from "../lib/prisma";
import { logger } from "../utils/logger";

/**
 * High-precision event logger using nanosecond-level timestamps
 * Designed for high-frequency data pipelines requiring quantum-level timing accuracy
 */
export class HighPrecisionEventLogger {
  private readonly hrtimeReference: bigint;
  private batchQueue: Array<{
    eventType: string;
    source: string;
    level: string;
    message: string;
    metadata?: Record<string, unknown>;
  }> = [];
  private batchSize: number;
  private flushInterval: ReturnType<typeof setInterval> | null = null;

  constructor(batchSize: number = 100, flushIntervalMs: number = 1000) {
    // Capture the reference time for nanosecond calculations
    this.hrtimeReference = process.hrtime.bigint();
    this.batchSize = batchSize;

    // Start the auto-flush interval
    if (flushIntervalMs > 0) {
      this.flushInterval = setInterval(
        () => this.flush().catch((err) => logger.error("Flush error:", err)),
        flushIntervalMs,
      );
    }
  }

  /**
   * Get the current nanosecond timestamp
   */
  private getNanosecondTimestamp(): bigint {
    return process.hrtime.bigint() - this.hrtimeReference;
  }

  /**
   * Log an event with nanosecond precision
   */
  async logEvent(
    eventType: string,
    source: string,
    level: string,
    message: string,
    metadata?: Record<string, unknown>,
  ): Promise<void> {
    const event = {
      eventType,
      source,
      level,
      message,
      ...(metadata && { metadata }),
    };

    // Add to batch queue
    this.batchQueue.push(event);

    // Flush if batch size reached
    if (this.batchQueue.length >= this.batchSize) {
      await this.flush();
    }
  }

  /**
   * Log a debug event
   */
  async debug(
    source: string,
    message: string,
    metadata?: Record<string, unknown>,
  ): Promise<void> {
    return this.logEvent("DEBUG", source, "debug", message, metadata);
  }

  /**
   * Log an info event
   */
  async info(
    source: string,
    message: string,
    metadata?: Record<string, unknown>,
  ): Promise<void> {
    return this.logEvent("INFO", source, "info", message, metadata);
  }

  /**
   * Log a warning event
   */
  async warn(
    source: string,
    message: string,
    metadata?: Record<string, unknown>,
  ): Promise<void> {
    return this.logEvent("WARN", source, "warn", message, metadata);
  }

  /**
   * Log an error event
   */
  async error(
    source: string,
    message: string,
    metadata?: Record<string, unknown>,
  ): Promise<void> {
    return this.logEvent("ERROR", source, "error", message, metadata);
  }

  /**
   * Flush all queued events to the database
   */
  async flush(): Promise<void> {
    if (this.batchQueue.length === 0) {
      return;
    }

    const eventsToFlush = this.batchQueue.splice(0, this.batchQueue.length);

    try {
      const clientAny = prisma as any;

      if (
        clientAny?.eventLog &&
        typeof clientAny.eventLog.createMany === "function"
      ) {
        await clientAny.eventLog.createMany({
          data: eventsToFlush.map((event) => ({
            eventType: event.eventType,
            source: event.source,
            level: event.level,
            message: event.message,
            metadata: event.metadata ? JSON.stringify(event.metadata) : null,
            timestampNs: this.getNanosecondTimestamp(),
          })),
          skipDuplicates: false,
        });
      }
    } catch (error) {
      // Log error but don't throw - ensure logging doesn't break the service
      logger.error("Failed to flush event log batch", {
        batchSize: eventsToFlush.length,
        error: error instanceof Error ? error.message : String(error),
      });

      // Re-queue events on failure for retry
      this.batchQueue.unshift(...eventsToFlush);
    }
  }

  /**
   * Gracefully shutdown the event logger
   */
  async shutdown(): Promise<void> {
    if (this.flushInterval) {
      clearInterval(this.flushInterval);
    }
    await this.flush();
  }

  /**
   * Get nanosecond timestamp relative to logger start
   */
  getRelativeNanoseconds(): bigint {
    return this.getNanosecondTimestamp();
  }

  /**
   * Get absolute nanosecond timestamp (process.hrtime.bigint())
   */
  static getAbsoluteNanoseconds(): bigint {
    return process.hrtime.bigint();
  }

  /**
   * Get current queue size
   */
  getQueueSize(): number {
    return this.batchQueue.length;
  }
}

// Export a singleton instance
export const highPrecisionEventLogger = new HighPrecisionEventLogger(100, 1000);

// Graceful shutdown handler
process.on("SIGINT", () => {
  highPrecisionEventLogger
    .shutdown()
    .then(() => {
      logger.info("High-precision event logger shut down gracefully");
      process.exit(0);
    })
    .catch((err) => {
      logger.error("Error during shutdown:", err);
      process.exit(1);
    });
});

process.on("SIGTERM", () => {
  highPrecisionEventLogger
    .shutdown()
    .then(() => {
      logger.info("High-precision event logger shut down gracefully");
      process.exit(0);
    })
    .catch((err) => {
      logger.error("Error during shutdown:", err);
      process.exit(1);
    });
});
