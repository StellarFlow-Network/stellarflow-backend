export declare class ErrorTracker {
    private failureCounters;
    private readonly threshold;
    trackFailure(serviceKey: string, errorDetails: any): boolean;
    trackSuccess(serviceKey: string): void;
    reset(serviceKey: string): void;
}
export declare const errorTracker: ErrorTracker;
//# sourceMappingURL=errorTracker.d.ts.map