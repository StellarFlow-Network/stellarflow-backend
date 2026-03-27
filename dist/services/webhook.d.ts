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
    private formatMessage;
}
export declare const webhookService: WebhookService;
//# sourceMappingURL=webhook.d.ts.map