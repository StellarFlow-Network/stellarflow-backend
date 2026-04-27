import prisma from "../lib/prisma";

type FailureRecord = {
  count: number;
  errors: unknown[];
};

export class ErrorTracker {
  private failureCounters = new Map<string, FailureRecord>();
  private readonly threshold = 3;
  /**
   * Track a failure for a specific service key.
   * Returns true when the configured threshold of consecutive failures is reached.
   * Also triggers a non-blocking DB write to record the failure.
   */
  trackFailure(serviceKey: string, errorDetails: unknown): boolean {
    const existing = this.failureCounters.get(serviceKey);

    if (existing) {
      existing.count += 1;
      existing.errors.push(errorDetails);
      this.failureCounters.set(serviceKey, existing);
      this.logError(serviceKey, errorDetails);
      return existing.count >= this.threshold;
    }

    this.failureCounters.set(serviceKey, { count: 1, errors: [errorDetails] });
    this.logError(serviceKey, errorDetails);
    return false;
  }

  trackSuccess(serviceKey: string): void {
    this.failureCounters.delete(serviceKey);
  }

  reset(serviceKey: string): void {
    this.failureCounters.delete(serviceKey);
  }

  // Write an error log without breaking the caller if DB logging fails.
  private async logError(
    serviceKey: string,
    errorDetails: unknown,
  ): Promise<void> {
    try {
      const clientAny = prisma as any;

      if (
        clientAny?.errorLog &&
        typeof clientAny.errorLog.create === "function"
      ) {
        await clientAny.errorLog.create({
          data: {
            providerName: serviceKey,
            errorMessage:
              errorDetails instanceof Error
                ? errorDetails.message
                : JSON.stringify(errorDetails),
            occurredAt: new Date(),
          },
        });
      }
    } catch {
      // Swallow DB errors to avoid breaking the service.
    }
  }
}

export const errorTracker = new ErrorTracker();
