export interface ConfirmedPrice {
    currency: string;
    rate: number;
    txHash: string;
    memoId: string | null;
    ledgerSeq: number;
    confirmedAt: Date;
}
export declare class SorobanEventListener {
    private bpManager;
    private server;
    private oraclePublicKey;
    private isRunning;
    private pollIntervalMs;
    private lastProcessedLedger;
    private pollTimer;
    constructor(pollIntervalMs?: number);
    getOraclePublicKey(): string;
    start(): Promise<void>;
    restart(pollIntervalMs?: number): void;
    private startPollingTimer;
    /**
     * Worker loop that processes packets from the queue at a controlled pace.
     */
    private startWorker;
    private pollTransactions;
    private pollOrderFilledEvents;
    /**
     * Polls Soroban for GovernanceVoted events emitted by the governance contract
     * and upserts a GovernanceVote row for each unique (accountId, proposalId) pair.
     *
     * Expected event topics: ["GovernanceVoted", accountId, proposalId]
     * Expected event data:   { choice: "For"|"Against"|"Abstain", weight: string }
     */
    private pollGovernanceVoteEvents;
    private extractMemoId;
    private parseOperations;
    stop(): void;
    isActive(): boolean;
    getQueueDepth(): number;
}
//# sourceMappingURL=sorobanEventListener.d.ts.map