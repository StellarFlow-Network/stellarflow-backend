export declare class ErrorTracker {
    private failureCounters;
    private readonly threshold;
    /**
     * Track a failure for a specific service key.
     * Returns true when the configured threshold of consecutive failures is reached.
     * Also triggers a non-blocking DB write to record the failure.
     */
    trackFailure(serviceKey: string, errorDetails: unknown): boolean;
    trackSuccess(serviceKey: string): void;
    reset(serviceKey: string): void;
    private logError;
}
export declare const errorTracker: ErrorTracker;
//# sourceMappingURL=errorTracker.d.ts.map