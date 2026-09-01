import dotenv from "dotenv";
import { Keypair, TransactionBuilder, Operation, Memo, xdr, Account, Contract, nativeToScVal, rpc as SorobanRpc, } from "@stellar/stellar-sdk";
import stellarProvider from "../lib/stellarProvider";
import { getStellarNetwork, getStellarNetworkPassphrase, } from "../lib/stellarNetwork";
import { sequenceManager } from "./sequence-manager";
import { assertSigningAllowed } from "../state/appState";
import { signer } from "../signer";
import { logger } from "../utils/logger";
dotenv.config();
class LocalTransactionTimeoutError extends Error {
    code = "LOCAL_TX_TIME_BOUND_EXPIRED";
    transactionHash;
    publicKey;
    constructor(transactionHash, publicKey) {
        super(`Transaction ${transactionHash} exceeded local time-bound and was recycled`);
        this.name = "LocalTransactionTimeoutError";
        this.transactionHash = transactionHash;
        this.publicKey = publicKey;
    }
}
export class StellarService {
    server;
    networkPassphrase;
    MAX_RETRIES = 3;
    FEE_INCREMENT_PERCENTAGE = 0.5; // 50% increase each retry
    RETRY_DELAY_MS = 2000; // 2 seconds delay between retries
    TRANSACTION_TIME_BOUND_SECONDS = 15;
    pendingTimeBoundTransactions = new Map();
    constructor() {
        this.networkPassphrase = getStellarNetworkPassphrase();
        // Use the shared StellarProvider so all services benefit from the same
        // failover state rather than each managing their own Horizon URL.
        this.server = stellarProvider.getServer();
    }
    /**
     * Returns the Stellar public key from the signer.
     */
    async getPublicKey() {
        return signer.getPublicKey();
    }
    /**
     * Fetches the recommended transaction fee from Horizon fee_stats.
     */
    async getRecommendedFee() {
        const feeStats = await this.server.feeStats();
        const fee = parseInt(feeStats.fee_charged.p50, 10);
        return Math.max(fee, 100).toString();
    }
    /**
     * Submit a price update to the Stellar network.
     */
    async submitPriceUpdate(currency, price, memoId) {
        await assertSigningAllowed();
        const baseFee = parseInt(await this.getRecommendedFee(), 10);
        const result = await this.submitTransactionWithRetries((sourceAccount, currentFee) => {
            return new TransactionBuilder(sourceAccount, {
                fee: currentFee.toString(),
                networkPassphrase: this.networkPassphrase,
            })
                .addOperation(Operation.manageData({
                name: `${currency}_PRICE`,
                value: price.toString(),
            }))
                .addMemo(Memo.text(memoId))
                .setTimeout(this.TRANSACTION_TIME_BOUND_SECONDS)
                .build();
        }, this.MAX_RETRIES, baseFee);
        const network = getStellarNetwork();
        const txURL = network === "TESTNET"
            ? `https://testnet.stellarexpert.org/tx/${result.hash}`
            : `https://stellarexpert.org/tx/${result.hash}`;
        logger.networkInfo(`✅ Price update for ${currency} confirmed. Hash: ${result.hash} | StellarExpert: ${txURL}`, { hash: result.hash, url: txURL });
        return result.hash;
    }
    async executeGovernanceProposal(contractId, proposalId) {
        await assertSigningAllowed();
        const publicKey = await this.getPublicKey();
        const sequence = await sequenceManager.getNextSequence(publicKey);
        const account = new Account(publicKey, sequence);
        const transaction = new TransactionBuilder(account, {
            fee: await this.getRecommendedFee(),
            networkPassphrase: this.networkPassphrase,
        })
            .addOperation(new Contract(contractId).call("execute", nativeToScVal(BigInt(proposalId), { type: "u64" })))
            .setTimeout(this.TRANSACTION_TIME_BOUND_SECONDS)
            .build();
        const rpcServer = stellarProvider.getRpcServer();
        const simulation = await rpcServer.simulateTransaction(transaction);
        const prepared = SorobanRpc.assembleTransaction(transaction, simulation).build();
        const signature = await signer.sign(prepared.hash());
        const keypair = Keypair.fromPublicKey(publicKey);
        prepared.signatures.push(new xdr.DecoratedSignature({
            hint: keypair.signatureHint(),
            signature,
        }));
        const submitted = await rpcServer.sendTransaction(prepared);
        for (let attempt = 0; attempt < 30; attempt++) {
            const result = await rpcServer.getTransaction(submitted.hash);
            if (result.status === "SUCCESS")
                return submitted.hash;
            if (result.status === "FAILED")
                throw new Error(`Governance proposal ${proposalId} failed`);
            await new Promise((resolve) => setTimeout(resolve, 1000));
        }
        throw new Error(`Governance proposal ${proposalId} confirmation timed out`);
    }
    /**
     * Submit multiple price updates in a single bundle.
     */
    async submitBatchedPriceUpdates(updates, memoId) {
        if (updates.length === 0) {
            throw new Error("Cannot submit empty batch of price updates");
        }
        await assertSigningAllowed();
        const baseFee = parseInt(await this.getRecommendedFee(), 10);
        const result = await this.submitTransactionWithRetries((sourceAccount, currentFee) => {
            const builder = new TransactionBuilder(sourceAccount, {
                fee: currentFee.toString(),
                networkPassphrase: this.networkPassphrase,
            });
            for (const update of updates) {
                builder.addOperation(Operation.manageData({
                    name: `${update.currency}_PRICE`,
                    value: update.price.toString(),
                }));
            }
            return builder
                .addMemo(Memo.text(memoId))
                .setTimeout(this.TRANSACTION_TIME_BOUND_SECONDS)
                .build();
        }, this.MAX_RETRIES, baseFee);
        const currencies = updates.map((u) => u.currency).join(", ");
        const network = getStellarNetwork();
        const txURL = network === "TESTNET"
            ? `https://testnet.stellarexpert.org/tx/${result.hash}`
            : `https://stellarexpert.org/tx/${result.hash}`;
        logger.networkInfo(`✅ Batched price update for [${currencies}] confirmed. Hash: ${result.hash} | StellarExpert: ${txURL}`, { hash: result.hash, url: txURL, currencies });
        return result.hash;
    }
    /**
     * Submit a multi-signed price update.
     */
    async submitMultiSignedPriceUpdate(currency, price, memoId, signatures) {
        await assertSigningAllowed();
        const baseFee = parseInt(await this.getRecommendedFee(), 10);
        const result = await this.submitMultiSignedTransaction((sourceAccount, currentFee) => {
            return new TransactionBuilder(sourceAccount, {
                fee: currentFee.toString(),
                networkPassphrase: this.networkPassphrase,
            })
                .addOperation(Operation.manageData({
                name: `${currency}_PRICE`,
                value: price.toString(),
            }))
                .addMemo(Memo.text(memoId))
                .setTimeout(this.TRANSACTION_TIME_BOUND_SECONDS)
                .build();
        }, signatures, this.MAX_RETRIES, baseFee);
        const network = getStellarNetwork();
        const txURL = network === "TESTNET"
            ? `https://testnet.stellarexpert.org/tx/${result.hash}`
            : `https://stellarexpert.org/tx/${result.hash}`;
        logger.networkInfo(`✅ Multi-signed price update for ${currency} confirmed. Hash: ${result.hash} | StellarExpert: ${txURL}`, { hash: result.hash, url: txURL });
        return result.hash;
    }
    /**
     * Generic method to submit a transaction with retries.
     */
    async submitTransactionWithRetries(builderFn, maxRetries = this.MAX_RETRIES, baseFee) {
        let attempt = 0;
        while (attempt <= maxRetries) {
            try {
                // Always resolve the current active server — may have changed after a failover
                this.server = stellarProvider.getServer();
                // Use SequenceManager to avoid collisions and redundant loadAccount calls
                const publicKey = await this.getPublicKey();
                const nextSequence = await sequenceManager.getNextSequence(publicKey);
                const sourceAccount = new Account(publicKey, nextSequence);
                const currentFee = Math.floor(baseFee * (1 + this.FEE_INCREMENT_PERCENTAGE * attempt));
                const transaction = builderFn(sourceAccount, currentFee);
                this.assertStrictTimeBounds(transaction);
                await assertSigningAllowed();
                const txHash = transaction.hash();
                const signature = await signer.sign(txHash);
                const kp = Keypair.fromPublicKey(publicKey);
                transaction.signatures.push(new xdr.DecoratedSignature({
                    hint: kp.signatureHint(),
                    signature: signature,
                }));
                return await this.submitWithTimeoutListener(transaction, publicKey);
            }
            catch (error) {
                const resultCode = error.response?.data?.extras?.result_codes?.transaction;
                if (resultCode === "tx_bad_seq" || this.isLocalTimeoutError(error)) {
                    logger.warn("⚠️ SequenceManager: stale or invalid local transaction assignment detected. Invalidating sequence and retrying...");
                    const publicKey = await this.getPublicKey();
                    await sequenceManager.syncSequence(publicKey);
                }
                attempt++;
                if (!this.isLocalTimeoutError(error)) {
                    stellarProvider.reportFailure(error);
                }
                if (this.isStuckError(error) && attempt <= maxRetries) {
                    logger.warn(`⚠️ Transaction stuck, expired, or fee too low (Attempt ${attempt}). Recycling locally and retrying...`);
                    if (!this.shouldRecycleImmediately(error)) {
                        await new Promise((resolve) => setTimeout(resolve, this.RETRY_DELAY_MS));
                    }
                    continue;
                }
                throw error;
            }
        }
        throw new Error(`Failed to submit transaction after ${maxRetries + 1} attempts`);
    }
    /**
     * Submit a multi-signed transaction with retries.
     */
    async submitMultiSignedTransaction(builderFn, signatures, maxRetries = this.MAX_RETRIES, baseFee) {
        let attempt = 0;
        while (attempt <= maxRetries) {
            try {
                this.server = stellarProvider.getServer();
                const publicKey = await this.getPublicKey();
                const nextSequence = await sequenceManager.getNextSequence(publicKey);
                const sourceAccount = new Account(publicKey, nextSequence);
                const currentFee = Math.floor(baseFee * (1 + this.FEE_INCREMENT_PERCENTAGE * attempt));
                const transaction = builderFn(sourceAccount, currentFee);
                this.assertStrictTimeBounds(transaction);
                await assertSigningAllowed();
                const txHash = transaction.hash();
                const signature = await signer.sign(txHash);
                const kp = Keypair.fromPublicKey(publicKey);
                transaction.signatures.push(new xdr.DecoratedSignature({
                    hint: kp.signatureHint(),
                    signature: signature,
                }));
                for (const sig of signatures) {
                    if (sig.signerPublicKey === publicKey)
                        continue;
                    try {
                        const signatureBuffer = Buffer.from(sig.signature, "hex");
                        const signerKeypair = Keypair.fromPublicKey(sig.signerPublicKey);
                        const decoratedSignature = new xdr.DecoratedSignature({
                            hint: signerKeypair.signatureHint(),
                            signature: signatureBuffer,
                        });
                        transaction.signatures.push(decoratedSignature);
                    }
                    catch (error) {
                        logger.error(`[StellarService] Failed to add signature for ${sig.signerPublicKey}:`, { error });
                    }
                }
                return await this.submitWithTimeoutListener(transaction, publicKey);
            }
            catch (error) {
                const resultCode = error.response?.data?.extras?.result_codes?.transaction;
                if (resultCode === "tx_bad_seq" || this.isLocalTimeoutError(error)) {
                    logger.warn("⚠️ SequenceManager: stale or invalid multi-sig assignment detected. Invalidating sequence...");
                    const publicKey = await this.getPublicKey();
                    await sequenceManager.syncSequence(publicKey);
                }
                attempt++;
                if (!this.isLocalTimeoutError(error)) {
                    stellarProvider.reportFailure(error);
                }
                if (this.isStuckError(error) && attempt <= maxRetries) {
                    if (!this.shouldRecycleImmediately(error)) {
                        await new Promise((resolve) => setTimeout(resolve, this.RETRY_DELAY_MS));
                    }
                    continue;
                }
                throw error;
            }
        }
        throw new Error(`Failed to submit multi-signed transaction after ${maxRetries + 1} attempts`);
    }
    assertStrictTimeBounds(transaction) {
        const timeBounds = transaction.timeBounds;
        const maxTime = Number(timeBounds?.maxTime);
        const nowSeconds = Math.floor(Date.now() / 1000);
        if (!Number.isFinite(maxTime) ||
            maxTime <= nowSeconds ||
            maxTime - nowSeconds > this.TRANSACTION_TIME_BOUND_SECONDS) {
            throw new Error(`Transaction envelope must include strict time_bounds of ${this.TRANSACTION_TIME_BOUND_SECONDS}s or less`);
        }
    }
    async submitWithTimeoutListener(transaction, publicKey) {
        const pending = this.registerPendingTimeBoundTransaction(transaction, publicKey);
        try {
            return await Promise.race([
                this.server.submitTransaction(transaction),
                new Promise((_, reject) => {
                    pending.timer = setTimeout(() => {
                        const activePending = this.pendingTimeBoundTransactions.get(pending.hash);
                        if (!activePending) {
                            return;
                        }
                        activePending.timedOut = true;
                        this.pendingTimeBoundTransactions.delete(pending.hash);
                        logger.warn(`[StellarService] Transaction ${pending.hash} exceeded ${this.TRANSACTION_TIME_BOUND_SECONDS}s time-bound. Recycling local assignment.`);
                        reject(new LocalTransactionTimeoutError(pending.hash, pending.publicKey));
                    }, Math.max(pending.expiresAtMs - Date.now(), 0));
                }),
            ]);
        }
        finally {
            this.clearPendingTimeBoundTransaction(pending.hash);
        }
    }
    registerPendingTimeBoundTransaction(transaction, publicKey) {
        const createdAtMs = Date.now();
        const hash = transaction.hash().toString("hex");
        const pending = {
            hash,
            publicKey,
            createdAtMs,
            expiresAtMs: createdAtMs + this.TRANSACTION_TIME_BOUND_SECONDS * 1000,
            timedOut: false,
        };
        this.pendingTimeBoundTransactions.set(hash, pending);
        return pending;
    }
    clearPendingTimeBoundTransaction(hash) {
        const pending = this.pendingTimeBoundTransactions.get(hash);
        if (!pending) {
            return;
        }
        if (pending.timer) {
            clearTimeout(pending.timer);
        }
        this.pendingTimeBoundTransactions.delete(hash);
    }
    isStuckError(error) {
        const resultCode = error.response?.data?.extras?.result_codes?.transaction;
        return (this.isLocalTimeoutError(error) ||
            resultCode === "tx_too_late" ||
            resultCode === "tx_insufficient_fee" ||
            resultCode === "tx_bad_seq" ||
            error.message?.includes("timeout") ||
            error.code === "ECONNABORTED");
    }
    shouldRecycleImmediately(error) {
        const resultCode = error.response?.data?.extras?.result_codes?.transaction;
        return this.isLocalTimeoutError(error) || resultCode === "tx_too_late";
    }
    isLocalTimeoutError(error) {
        return error instanceof LocalTransactionTimeoutError;
    }
    generateMemoId(currency) {
        const timestamp = Math.floor(Date.now() / 1000);
        const random = Math.floor(Math.random() * 1000).toString().padStart(3, "0");
        const id = `SF-${currency}-${timestamp}-${random}`;
        return id.substring(0, 28);
    }
}
//# sourceMappingURL=stellarService.js.map