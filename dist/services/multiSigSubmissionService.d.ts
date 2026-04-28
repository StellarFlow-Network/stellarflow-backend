/**
 * MultiSigSubmissionService
 * Handles the automatic submission of approved multi-sig prices to Stellar.
 * Runs as a background job/scheduler.
 */
export declare class MultiSigSubmissionService {
    private stellarService;
    private pollIntervalMs;
    private isRunning;
    private pollTimer;
    constructor(pollIntervalMs?: number);
    /**
     * Start the background submission service.
     * This will periodically check for approved multi-sig prices and submit them to Stellar.
     */
    start(): Promise<void>;
    /**
     * Stop the background submission service.
     */
    stop(): void;
    restart(newIntervalMs: number): void;
    /**
     * Check for approved multi-sig prices and submit them to Stellar.
     * This is the main polling function.
     */
    private checkAndSubmitApprovedPrices;
    /**
     * Submit a single approved multi-sig price to Stellar.
     */
    private submitApprovedPrice;
    /**
     * Cleanup expired multi-sig requests.
     * Can be called manually or as part of a scheduled maintenance task.
     */
    cleanupExpired(): Promise<number>;
    /**
     * Get status of the background service.
     */
    getStatus(): {
        isRunning: boolean;
        pollIntervalMs: number;
    };
}
export declare const multiSigSubmissionService: MultiSigSubmissionService;
//# sourceMappingURL=multiSigSubmissionService.d.ts.map