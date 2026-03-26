export class ErrorTracker {
  private failureCounters: Map<string, { count: number; errors: unknown[] }> =
    new Map();
  private readonly threshold = 3;

  trackFailure(serviceKey: string, errorDetails: unknown): boolean {
    const existing = this.failureCounters.get(serviceKey);
    if (existing) {
      existing.count += 1;
      existing.errors.push(errorDetails);
      this.failureCounters.set(serviceKey, existing);
      return existing.count >= this.threshold;
    }

    this.failureCounters.set(serviceKey, { count: 1, errors: [errorDetails] });
    return false;
  }

  trackSuccess(serviceKey: string): void {
    this.failureCounters.delete(serviceKey);
  }

  reset(serviceKey: string): void {
    this.failureCounters.delete(serviceKey);
  }
}

export const errorTracker = new ErrorTracker();
export const errorTracker = new ErrorTracker();
