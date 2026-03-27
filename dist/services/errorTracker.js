export class ErrorTracker {
    failureCounters = new Map();
    threshold = 3;
    trackFailure(serviceKey, errorDetails) {
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
    trackSuccess(serviceKey) {
        this.failureCounters.delete(serviceKey);
    }
    reset(serviceKey) {
        this.failureCounters.delete(serviceKey);
    }
}
export const errorTracker = new ErrorTracker();
export const errorTracker = new ErrorTracker();
//# sourceMappingURL=errorTracker.js.map