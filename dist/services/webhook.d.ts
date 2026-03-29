export declare class WebhookService {
    private webhookUrl;
    private platform;
    constructor();
    sendErrorNotification(errorDetails: {
        errorType: string;
        errorMessage: string;
        attempts: number;
        service: string;
        pricePair: string;
        timestamp: Date;
    }): Promise<void>;
    sendManualReviewNotification(reviewDetails: {
        reviewId: number;
        currency: string;
        rate: number;
        previousRate: number;
        changePercent: number;
        source: string;
        timestamp: Date;
        reason: string;
    }): Promise<void>;
    private postMessage;
    private formatErrorMessage;
    private formatReviewMessage;
}
export declare const webhookService: WebhookService;
//# sourceMappingURL=webhook.d.ts.map