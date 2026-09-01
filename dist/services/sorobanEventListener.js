import { BackpressureManager, PacketPriority } from "../queue/backpressure";
import prisma from "../lib/prisma";
import { broadcastToSessions } from "../lib/socket";
import stellarProvider from "../lib/stellarProvider";
import dotenv from "dotenv";
import { logger } from "../utils/logger";
import { verifyOrderFilledEvent } from "./orderFillVerificationService.js";
import { ingestGovernanceVoteEvent } from "./voterHistoryService.js";
import { getCacheInvalidationManager } from "../cache/CacheInvalidationManager";
import { getOrderBookSnapshotEngine } from "./orderBookSnapshotEngine";
dotenv.config();
export class SorobanEventListener {
    bpManager = new BackpressureManager();
    server;
    oraclePublicKey;
    isRunning = false;
    pollIntervalMs;
    lastProcessedLedger = 0;
    pollTimer = null;
    constructor(pollIntervalMs = 15000) {
        const secret = process.env.ORACLE_SECRET_KEY ??
            process.env.SOROBAN_ADMIN_SECRET ??
            process.env.STELLAR_SECRET;
        if (!secret) {
            throw new Error("Stellar secret key not found in environment variables. Please set STELLAR_SECRET or SOROBAN_ADMIN_SECRET.");
        }
        this.oraclePublicKey = "";
        this.pollIntervalMs = pollIntervalMs;
        this.server = stellarProvider.getServer();
    }
    getOraclePublicKey() {
        return this.oraclePublicKey;
    }
    async start() {
        if (this.isRunning) {
            logger.warn("[EventListener] SorobanEventListener is already running");
            return;
        }
        this.isRunning = true;
        const { signer } = await import("../signer/index.js");
        this.oraclePublicKey = await signer.getPublicKey();
        logger.info(`[EventListener] Starting listener for account ${this.oraclePublicKey}`);
        const lastRecord = await prisma.onChainPrice.findFirst({
            orderBy: { ledgerSeq: "desc" },
        });
        if (lastRecord) {
            this.lastProcessedLedger = lastRecord.ledgerSeq;
            logger.info(`[EventListener] Resuming from ledger ${this.lastProcessedLedger}`);
        }
        // Start the background worker to process the backpressure queue
        this.startWorker();
        // Initial poll
        await this.pollTransactions();
        // Start periodic polling
        this.startPollingTimer();
    }
    restart(pollIntervalMs) {
        this.stop();
        if (pollIntervalMs !== undefined)
            this.pollIntervalMs = pollIntervalMs;
        this.start().catch((err) => logger.error("[EventListener] Restart failed:", err));
    }
    startPollingTimer() {
        this.pollTimer = setInterval(() => {
            this.pollTransactions().catch((err) => {
                logger.networkError("[EventListener] Poll error:", { err });
            });
        }, this.pollIntervalMs);
    }
    /**
     * Worker loop that processes packets from the queue at a controlled pace.
     */
    async startWorker() {
        logger.info("[Worker] Backpressure consumer loop started.");
        while (this.isRunning) {
            const packet = await this.bpManager.dequeue();
            if (packet) {
                try {
                    const price = packet.data;
                    if (packet.priority === PacketPriority.STANDARD) {
                        // Essential data: Save to DB
                        await prisma.onChainPrice.create({
                            data: {
                                currency: price.currency,
                                rate: price.rate,
                                txHash: price.txHash,
                                memoId: price.memoId,
                                ledgerSeq: price.ledgerSeq,
                                confirmedAt: price.confirmedAt,
                            },
                        });
                    }
                    // Broadcast all successful updates (Essential or Metric) to UI
                    broadcastToSessions("price_update", price);
                    // Issue #789 – Purge stale Redis response caches before warming so
                    // the warming worker repopulates with fresh data.
                    try {
                        await getCacheInvalidationManager().onLedgerEvent(price.ledgerSeq, price);
                    }
                    catch (err) {
                        logger.error("[EventListener] Cache invalidation failed:", err);
                    }
                    // Trigger cache warming on new price update. Dynamically imported
                    // because the warming worker pulls in the signer, which performs
                    // secret retrieval at module load.
                    const { getCacheWarmingWorker } = await import("./cacheWarmingWorker.js");
                    const cacheWarmingWorker = getCacheWarmingWorker();
                    cacheWarmingWorker.onNewLedger(price.ledgerSeq).catch((err) => {
                        logger.error("[EventListener] Cache warming failed:", err);
                    });
                    // Trigger order book snapshot on new ledger (every N ledgers)
                    const orderBookSnapshotEngine = getOrderBookSnapshotEngine();
                    orderBookSnapshotEngine.onNewLedger(price.ledgerSeq).catch((err) => {
                        logger.error("[EventListener] Order book snapshot failed:", err);
                    });
                }
                catch (err) {
                    logger.error("[Worker] Failed to process queued price:", err);
                }
            }
            else {
                // Wait 100ms if queue is empty to prevent CPU spinning
                await new Promise((resolve) => setTimeout(resolve, 100));
            }
        }
    }
    async pollTransactions() {
        try {
            this.server = stellarProvider.getServer();
            await this.pollOrderFilledEvents();
            await this.pollGovernanceVoteEvents();
            const transactions = await this.server
                .transactions()
                .forAccount(this.oraclePublicKey)
                .order("desc")
                .limit(50)
                .call();
            for (const tx of transactions.records) {
                if (tx.ledger_attr <= this.lastProcessedLedger)
                    continue;
                const memoId = this.extractMemoId(tx);
                if (!memoId || !memoId.startsWith("SF-"))
                    continue;
                const prices = await this.parseOperations(tx, memoId);
                for (const price of prices) {
                    // Wrap price in a packet and send to queue
                    const packet = {
                        priority: PacketPriority.STANDARD, // Using Standard for financial data
                        data: price,
                        timestamp: Date.now(),
                    };
                    const accepted = await this.bpManager.enqueue(packet);
                    if (accepted) {
                        // Update tracking only if it was accepted by queue
                        if (price.ledgerSeq > this.lastProcessedLedger) {
                            this.lastProcessedLedger = price.ledgerSeq;
                        }
                    }
                }
            }
        }
        catch (error) {
            stellarProvider.reportFailure(error);
            if (error instanceof Error && error.message.includes("status code 404"))
                return;
            throw error;
        }
    }
    async pollOrderFilledEvents() {
        const contractId = process.env.CONTRACT_ID?.trim();
        if (!contractId)
            return;
        const rpc = stellarProvider.getRpcServer();
        const response = await rpc.getEvents({
            startLedger: Math.max(1, this.lastProcessedLedger),
            filters: [{ type: "contract", contractIds: [contractId] }],
            limit: 100,
        });
        for (const event of response.events ?? []) {
            await verifyOrderFilledEvent(event);
            const ledger = Number(event.ledger ?? 0);
            if (ledger > this.lastProcessedLedger)
                this.lastProcessedLedger = ledger;
        }
    }
    /**
     * Polls Soroban for GovernanceVoted events emitted by the governance contract
     * and upserts a GovernanceVote row for each unique (accountId, proposalId) pair.
     *
     * Expected event topics: ["GovernanceVoted", accountId, proposalId]
     * Expected event data:   { choice: "For"|"Against"|"Abstain", weight: string }
     */
    async pollGovernanceVoteEvents() {
        const contractId = (process.env.GOVERNANCE_CONTRACT_ID ?? process.env.CONTRACT_ID)?.trim();
        if (!contractId)
            return;
        const rpc = stellarProvider.getRpcServer();
        let response;
        try {
            response = await rpc.getEvents({
                startLedger: Math.max(1, this.lastProcessedLedger),
                filters: [
                    {
                        type: "contract",
                        contractIds: [contractId],
                        topics: [["GovernanceVoted", "*", "*"]],
                    },
                ],
                limit: 200,
            });
        }
        catch (err) {
            logger.networkError("[EventListener] GovernanceVoted poll failed:", {
                err,
            });
            return;
        }
        for (const event of response.events ?? []) {
            try {
                // Topics: [eventName, accountId, proposalId]
                const topics = event.topic ?? [];
                const accountId = topics[1];
                const proposalId = topics[2];
                if (!accountId || !proposalId)
                    continue;
                // Data value is a Soroban SCVal map – coerce to plain object
                const dataVal = event.value?.value ?? event.value ?? {};
                const choice = dataVal.choice ?? "Abstain";
                const weight = dataVal.weight ?? "0";
                const txHash = event.txHash ?? event.id ?? null;
                const ledger = Number(event.ledger ?? 0);
                const closedAt = event.ledgerClosedAt
                    ? new Date(event.ledgerClosedAt)
                    : new Date();
                await ingestGovernanceVoteEvent({
                    accountId,
                    proposalId,
                    choice,
                    weight,
                    txHash,
                    votedAt: closedAt,
                });
                if (ledger > this.lastProcessedLedger)
                    this.lastProcessedLedger = ledger;
            }
            catch (err) {
                logger.error("[EventListener] Failed to ingest GovernanceVoted event:", err);
            }
        }
    }
    // ... (Keep extractMemoId and parseOperations methods as they were) ...
    extractMemoId(tx) {
        if (tx.memo_type === "text" && tx.memo)
            return tx.memo;
        return null;
    }
    async parseOperations(tx, memoId) {
        const confirmedPrices = [];
        try {
            const operations = await tx.operations();
            for (const op of operations.records) {
                if (op.type !== "manage_data")
                    continue;
                const manageDataOp = op;
                if (!manageDataOp.name.endsWith("_PRICE"))
                    continue;
                const currency = manageDataOp.name.replace("_PRICE", "");
                const valueBase64 = manageDataOp.value;
                if (!valueBase64)
                    continue;
                const rate = parseFloat(atob(String(valueBase64)));
                if (isNaN(rate))
                    continue;
                confirmedPrices.push({
                    currency,
                    rate,
                    txHash: tx.hash,
                    memoId,
                    ledgerSeq: tx.ledger_attr,
                    confirmedAt: new Date(tx.created_at),
                });
            }
        }
        catch (error) {
            logger.networkError(`[EventListener] Error parsing tx ${tx.hash}:`, {
                error,
            });
        }
        return confirmedPrices;
    }
    stop() {
        if (this.pollTimer)
            clearInterval(this.pollTimer);
        this.pollTimer = null;
        this.isRunning = false;
        logger.info("[EventListener] Stopped");
    }
    isActive() {
        return this.isRunning;
    }
}
//# sourceMappingURL=sorobanEventListener.js.map