cat > src / services / errorTracker.ts << 'EOF';
export class ErrorTracker {
    failureCounters = new Map();
    threshold = 3;
    trackFailure(serviceKey, errorDetails) {
        const existing = this.failureCounters.get(serviceKey);
        if (existing) {
            existing.count++;
            existing.errors.push(errorDetails);
            this.failureCounters.set(serviceKey, existing);
            return existing.count >= this.threshold;
        }
        else {
            this.failureCounters.set(serviceKey, { count: 1, errors: [errorDetails] });
            return false;
        }
    }
    trackSuccess(serviceKey) {
        this.failureCounters.delete(serviceKey);
    }
    reset(serviceKey) {
        this.failureCounters.delete(serviceKey);
    }
}
export const errorTracker = new ErrorTracker();
EOF;
//# sourceMappingURL=errorTracker.js.map