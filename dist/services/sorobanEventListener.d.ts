export interface ConfirmedPrice {
    currency: string;
    rate: number;
    txHash: string;
    memoId: string | null;
    ledgerSeq: number;
    confirmedAt: Date;
}
export declare class SorobanEventListener {
    private server;
    private oraclePublicKey;
    private isRunning;
    private pollIntervalMs;
    private lastProcessedLedger;
    private pollTimer;
    constructor(pollIntervalMs?: number);
    start(): Promise<void>;
    stop(): void;
    restart(newIntervalMs: number): void;
    private pollTransactions;
    private extractMemoId;
    private parseOperations;
    private saveConfirmedPrices;
    private emitPriceUpdates;
    getLatestConfirmedPrice(currency: string): Promise<ConfirmedPrice | null>;
    getConfirmedPriceHistory(currency: string, limit?: number): Promise<ConfirmedPrice[]>;
    isActive(): boolean;
    getOraclePublicKey(): string;
}
//# sourceMappingURL=sorobanEventListener.d.ts.map