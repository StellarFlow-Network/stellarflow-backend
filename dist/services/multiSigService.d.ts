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
    private localSignerSecret;
    private signerName;
    private readonly SIGNATURE_EXPIRY_MS;
    private readonly REQUIRED_SIGNATURES;
    constructor();
    /**
     * Create a multi-sig price update request.
     * This initiates the process where the price needs to be signed by multiple servers.
     */
    createMultiSigRequest(priceReviewId: number, currency: string, rate: number, source: string, memoId: string): Promise<SignatureRequest>;
    /**
     * Sign a multi-sig price update locally.
     * This creates a signature from the current server instance and records it.
     */
    signMultiSigPrice(multiSigPriceId: number): Promise<{
        signature: string;
        signerPublicKey: string;
    }>;
    /**
     * Request a signature from a remote server.
     * Sends an HTTP request to a peer server to sign the price update.
     */
    requestRemoteSignature(multiSigPriceId: number, remoteServerUrl: string): Promise<{
        success: boolean;
        error?: string;
    }>;
    /**
     * Get a pending multi-sig price by ID.
     * Returns the price details and current signature status.
     */
    getMultiSigPrice(multiSigPriceId: number): Promise<any>;
    /**
     * Get all pending multi-sig prices.
     * Useful for monitoring and checking expiration.
     */
    getPendingMultiSigPrices(): Promise<any[]>;
    /**
     * Clean up expired multi-sig prices.
     * Should be called periodically by a background job.
     */
    cleanupExpiredRequests(): Promise<number>;
    /**
     * Mark a multi-sig price as approved (all signatures collected).
     * This happens automatically when all required signatures are collected.
     */
    private approveMultiSigPrice;
    /**
     * Get all signatures for a multi-sig price.
     * Returns the signatures needed for submitting to Stellar.
     */
    getSignatures(multiSigPriceId: number): Promise<any[]>;
    /**
     * Mark a multi-sig price as submitted to Stellar.
     * Records the transaction hash and memo ID.
     */
    recordSubmission(multiSigPriceId: number, memoId: string, stellarTxHash: string): Promise<void>;
    /**
     * Create a deterministic message for signing.
     * Must be consistent across all servers to ensure valid multi-sig.
     */
    private createSignatureMessage;
    /**
     * Get this server's signer identity.
     */
    getLocalSignerInfo(): {
        publicKey: string;
        name: string;
    };
}
export declare const multiSigService: MultiSigService;
//# sourceMappingURL=multiSigService.d.ts.map