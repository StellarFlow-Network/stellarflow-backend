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
export declare class WebhookService {
    private webhookUrl;
    private platform;
    constructor();
    sendErrorNotification(errorDetails: ErrorDetails): Promise<void>;
    sendManualReviewNotification(reviewDetails: ReviewDetails): Promise<void>;
    private postMessage;
    private formatErrorMessage;
    private formatReviewMessage;
}
export declare const webhookService: WebhookService;
export {};
//# sourceMappingURL=webhook.d.ts.map