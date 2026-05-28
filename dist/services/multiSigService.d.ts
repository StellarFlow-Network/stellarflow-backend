export interface SignatureRequest {
    multiSigPriceId: number;
    currency: string;
    rate: number;
    source: string;
    memoId: string;
    requiredSignatures: number;
}
export interface SignaturePayload {
    multiSigPriceId: number;
    currency: string;
    rate: number;
    source: string;
    memoId: string;
    signerPublicKey: string;
}
export declare class MultiSigService {
    private localSignerPublicKey;
    private readonly signerName;
    private readonly SIGNATURE_EXPIRY_MS;
    private readonly REQUIRED_SIGNATURES;
    constructor();
    private initializeSigner;
    createMultiSigRequest(priceReviewId: number, currency: string, rate: number, source: string, memoId: string): Promise<SignatureRequest>;
    signMultiSigPrice(multiSigPriceId: number): Promise<{
        signature: string;
        signerPublicKey: string;
    }>;
    requestRemoteSignature(multiSigPriceId: number, remoteServerUrl: string): Promise<{
        success: boolean;
        error?: string;
    }>;
    getMultiSigPrice(multiSigPriceId: number): Promise<any>;
    getPendingMultiSigPrices(): Promise<any[]>;
    cleanupExpiredRequests(): Promise<number>;
    getSignatures(multiSigPriceId: number): Promise<any[]>;
    /**
     * Mark a multi-sig price as submitted to Stellar.
     * ── INSTRUMENTED ──
     * This is the closest point to an actual Stellar submission in this service.
     * We record success, duration, and fee here because by the time
     * recordSubmission() is called, the tx has already landed on-chain.
     */
    recordSubmission(multiSigPriceId: number, memoId: string, stellarTxHash: string, asset?: string, // optional — caller can pass e.g. "XLM/USD"
    feeStroops?: number): Promise<void>;
    getLocalSignerInfo(): {
        publicKey: string;
        name: string;
    };
    private approveMultiSigPrice;
    private createSignatureMessage;
    /** Look up the currency label for a multiSigPrice row. */
    private resolveCurrency;
    /** Map errors to stable Prometheus label values. */
    private classifyError;
}
export declare const multiSigService: MultiSigService;
//# sourceMappingURL=multiSigService.d.ts.map