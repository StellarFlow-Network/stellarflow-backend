type ErrorDetails = {
    errorType: string;
    errorMessage: string;
    attempts: number;
    service: string;
    pricePair: string;
    timestamp: Date;
};
type ReviewDetails = {
    reviewId: number;
    currency: string;
    rate: number;
    previousRate: number;
    changePercent: number;
    source: string;
    timestamp: Date;
    reason: string;
};
type GasBalanceAlertDetails = {
    currentBalance: number;
    threshold: number;
    walletAddress?: string;
    timestamp: Date;
};
type MonitorFailureAlertDetails = {
    consecutiveFailures: number;
    lastKnownBalance: number | null;
    timestamp: Date;
};
type PriorityAlertDetails = {
    currency: string;
    rate: number;
    zScore: number;
    mean: number;
    stdDev: number;
    timestamp: Date | number;
};
type GasSpikeAlertDetails = {
    txType: string;
    metric: string;
    current: number;
    baselineMean: number;
    percentIncrease: number;
    zScore: number;
    baselineSampleCount: number;
    timestamp: Date;
};
export declare class WebhookService {
    private webhookUrl;
    private platform;
    constructor();
    sendErrorNotification(errorDetails: ErrorDetails): Promise<void>;
    sendManualReviewNotification(reviewDetails: ReviewDetails): Promise<void>;
    sendGasBalanceAlert(alertDetails: GasBalanceAlertDetails): Promise<void>;
    sendMonitorFailureAlert(alertDetails: MonitorFailureAlertDetails): Promise<void>;
    sendPriorityAlert(alertDetails: PriorityAlertDetails): Promise<void>;
    /** Alerts the ops channel when transaction gas usage spikes unexpectedly (Issue #786). */
    sendGasSpikeAlert(alertDetails: GasSpikeAlertDetails): Promise<void>;
    private postMessage;
    private formatErrorMessage;
    private formatReviewMessage;
    private formatGasBalanceAlert;
    private formatMonitorFailureAlert;
    private formatPriorityAlert;
    private formatGasSpikeAlert;
}
export declare function getWebhookService(): WebhookService;
export declare const webhookService: WebhookService;
export {};
//# sourceMappingURL=webhook.d.ts.map