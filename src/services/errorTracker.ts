export class ErrorTracker {
  private failureCounters: Map<string, { count: number; errors: any[] }> = new Map();
  private readonly threshold = 3;

  trackFailure(serviceKey: string, errorDetails: any): boolean {
    const existing = this.failureCounters.get(serviceKey);
    if (existing) {
      existing.count++;
      existing.errors.push(errorDetails);
      this.failureCounters.set(serviceKey, existing);
      return existing.count >= this.threshold;
    } else {
      this.failureCounters.set(serviceKey, { count: 1, errors: [errorDetails] });
      return false;
    }
  }

  trackSuccess(serviceKey: string): void {
    this.failureCounters.delete(serviceKey);
  }

  reset(serviceKey: string): void {
    this.failureCounters.delete(serviceKey);
  }
}

export const errorTracker = new ErrorTracker();