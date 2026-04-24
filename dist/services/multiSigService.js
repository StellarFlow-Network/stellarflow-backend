import prisma from "../lib/prisma";
import { Keypair } from "@stellar/stellar-sdk";
import dotenv from "dotenv";
import { assertSigningAllowed } from "../state/appState";
/* global fetch */
dotenv.config();
export class MultiSigService {
    localSignerPublicKey;
    localSignerSecret;
    signerName;
    SIGNATURE_EXPIRY_MS = 60 * 60 * 1000;
    REQUIRED_SIGNATURES;
    constructor() {
        const secret = process.env.ORACLE_SECRET_KEY || process.env.SOROBAN_ADMIN_SECRET;
        if (!secret) {
            throw new Error("ORACLE_SECRET_KEY or SOROBAN_ADMIN_SECRET not found in environment variables");
        }
        this.localSignerSecret = secret;
        this.localSignerPublicKey = Keypair.fromSecret(secret).publicKey();
        this.signerName = process.env.ORACLE_SIGNER_NAME || "oracle-server";
        const requiredSignatures = Number.parseInt(process.env.MULTI_SIG_REQUIRED_COUNT || "2", 10);
        this.REQUIRED_SIGNATURES =
            Number.isFinite(requiredSignatures) && requiredSignatures > 0
                ? requiredSignatures
                : 2;
    }
    /**
     * Create a multi-sig price update request.
     * This initiates the process where the price needs to be signed by multiple servers.
     */
    async createMultiSigRequest(priceReviewId, currency, rate, source, memoId) {
        const expiresAt = new Date(Date.now() + this.SIGNATURE_EXPIRY_MS);
        const created = await prisma.multiSigPrice.create({
            data: {
                priceReviewId,
                currency,
                rate,
                source,
                memoId,
                status: "PENDING",
                requiredSignatures: this.REQUIRED_SIGNATURES,
                collectedSignatures: 0,
                expiresAt,
            },
        });
        console.info(`[MultiSig] Created signature request ${created.id} for ${currency} rate ${rate}`);
        return {
            multiSigPriceId: created.id,
            currency,
            rate,
            source,
            memoId,
            requiredSignatures: this.REQUIRED_SIGNATURES,
        };
    }
    /**
     * Sign a multi-sig price update locally.
     * This creates a signature from the current server instance and records it.
     */
    async signMultiSigPrice(multiSigPriceId) {
        const multiSigPrice = await prisma.multiSigPrice.findUnique({
            where: { id: multiSigPriceId },
        });
        if (!multiSigPrice) {
            throw new Error(`MultiSigPrice ${multiSigPriceId} not found`);
        }
        if (multiSigPrice.status !== "PENDING") {
            throw new Error(`Cannot sign MultiSigPrice ${multiSigPriceId} - status is ${multiSigPrice.status}`);
        }
        if (new Date() > multiSigPrice.expiresAt) {
            await prisma.multiSigPrice.update({
                where: { id: multiSigPriceId },
                data: { status: "EXPIRED" },
            });
            throw new Error(`MultiSigPrice ${multiSigPriceId} has expired`);
        }
        await assertSigningAllowed();
        const signatureMessage = this.createSignatureMessage(multiSigPrice.currency, multiSigPrice.rate.toString(), multiSigPrice.source);
        const signature = Keypair.fromSecret(this.localSignerSecret)
            .sign(Buffer.from(signatureMessage, "utf-8"))
            .toString("hex");
        let createdSignature = true;
        try {
            await prisma.multiSigSignature.create({
                data: {
                    multiSigPriceId,
                    signerPublicKey: this.localSignerPublicKey,
                    signerName: this.signerName,
                    signature,
                },
            });
        }
        catch (error) {
            if (error?.code !== "P2002") {
                throw error;
            }
            createdSignature = false;
        }
        if (createdSignature) {
            const updated = await prisma.multiSigPrice.update({
                where: { id: multiSigPriceId },
                data: {
                    collectedSignatures: {
                        increment: 1,
                    },
                },
            });
            console.info(`[MultiSig] Added signature ${updated.collectedSignatures}/${updated.requiredSignatures} for MultiSigPrice ${multiSigPriceId}`);
            if (updated.collectedSignatures >= updated.requiredSignatures) {
                await this.approveMultiSigPrice(multiSigPriceId);
            }
        }
        return { signature, signerPublicKey: this.localSignerPublicKey };
    }
    /**
     * Request a signature from a remote server.
     * Sends an HTTP request to a peer server to sign the price update.
     */
    async requestRemoteSignature(multiSigPriceId, remoteServerUrl) {
        try {
            await assertSigningAllowed();
            const multiSigPrice = await prisma.multiSigPrice.findUnique({
                where: { id: multiSigPriceId },
            });
            if (!multiSigPrice) {
                return {
                    success: false,
                    error: `MultiSigPrice ${multiSigPriceId} not found`,
                };
            }
            const payload = {
                multiSigPriceId,
                currency: multiSigPrice.currency,
                rate: multiSigPrice.rate.toNumber(),
                source: multiSigPrice.source,
                memoId: multiSigPrice.memoId || "",
                signerPublicKey: this.localSignerPublicKey,
            };
            const response = await fetch(`${remoteServerUrl}/api/v1/price-updates/sign`, {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    Authorization: `Bearer ${process.env.MULTI_SIG_AUTH_TOKEN || ""}`,
                },
                body: JSON.stringify(payload),
            });
            if (!response.ok) {
                const error = await response.text().catch(() => response.statusText);
                return { success: false, error: `Remote server error: ${error}` };
            }
            const result = (await response.json());
            if (result.success === false) {
                return {
                    success: false,
                    error: result.error || "Remote server rejected the signing request",
                };
            }
            const signatureData = result.data ?? result;
            if (!signatureData.signature || !signatureData.signerPublicKey) {
                return {
                    success: false,
                    error: "Remote server did not return signature data",
                };
            }
            let createdSignature = true;
            try {
                await prisma.multiSigSignature.create({
                    data: {
                        multiSigPriceId,
                        signerPublicKey: signatureData.signerPublicKey,
                        signerName: signatureData.signerName || "remote-signer",
                        signature: signatureData.signature,
                    },
                });
            }
            catch (error) {
                if (error?.code !== "P2002") {
                    throw error;
                }
                createdSignature = false;
            }
            if (createdSignature) {
                const updated = await prisma.multiSigPrice.update({
                    where: { id: multiSigPriceId },
                    data: {
                        collectedSignatures: {
                            increment: 1,
                        },
                    },
                });
                console.info(`[MultiSig] Added remote signature ${updated.collectedSignatures}/${updated.requiredSignatures} for MultiSigPrice ${multiSigPriceId}`);
                if (updated.collectedSignatures >= updated.requiredSignatures) {
                    await this.approveMultiSigPrice(multiSigPriceId);
                }
            }
            return { success: true };
        }
        catch (error) {
            console.error(`[MultiSig] Failed to request signature from ${remoteServerUrl}:`, error);
            return { success: false, error: String(error) };
        }
    }
    /**
     * Get a pending multi-sig price by ID.
     * Returns the price details and current signature status.
     */
    async getMultiSigPrice(multiSigPriceId) {
        return prisma.multiSigPrice.findUnique({
            where: { id: multiSigPriceId },
            include: {
                multiSigSignatures: {
                    select: {
                        signerPublicKey: true,
                        signerName: true,
                        signature: true,
                        signedAt: true,
                    },
                },
            },
        });
    }
    /**
     * Get all pending multi-sig prices.
     * Useful for monitoring and checking expiration.
     */
    async getPendingMultiSigPrices() {
        return prisma.multiSigPrice.findMany({
            where: { status: "PENDING" },
            include: {
                multiSigSignatures: {
                    select: {
                        signerPublicKey: true,
                        signerName: true,
                        signedAt: true,
                    },
                },
            },
            orderBy: { requestedAt: "desc" },
        });
    }
    /**
     * Clean up expired multi-sig prices.
     * Should be called periodically by a background job.
     */
    async cleanupExpiredRequests() {
        const result = await prisma.multiSigPrice.updateMany({
            where: {
                status: "PENDING",
                expiresAt: { lt: new Date() },
            },
            data: {
                status: "EXPIRED",
            },
        });
        if (result.count > 0) {
            console.warn(`[MultiSig] Expired ${result.count} multi-sig price requests`);
        }
        return result.count;
    }
    /**
     * Get all signatures for a multi-sig price.
     * Returns the signatures needed for submitting to Stellar.
     */
    async getSignatures(multiSigPriceId) {
        return prisma.multiSigSignature.findMany({
            where: { multiSigPriceId },
        });
    }
    /**
     * Mark a multi-sig price as submitted to Stellar.
     * Records the transaction hash and memo ID.
     */
    async recordSubmission(multiSigPriceId, memoId, stellarTxHash) {
        await prisma.multiSigPrice.update({
            where: { id: multiSigPriceId },
            data: {
                memoId,
                stellarTxHash,
                submittedAt: new Date(),
            },
        });
        console.info(`[MultiSig] MultiSigPrice ${multiSigPriceId} submitted to Stellar - TxHash: ${stellarTxHash}`);
    }
    /**
     * Get this server's signer identity.
     */
    getLocalSignerInfo() {
        return {
            publicKey: this.localSignerPublicKey,
            name: this.signerName,
        };
    }
    /**
     * Mark a multi-sig price as approved (all signatures collected).
     * This happens automatically when all required signatures are collected.
     */
    async approveMultiSigPrice(multiSigPriceId) {
        await prisma.multiSigPrice.update({
            where: { id: multiSigPriceId },
            data: {
                status: "APPROVED",
            },
        });
        console.info(`[MultiSig] MultiSigPrice ${multiSigPriceId} is now APPROVED (all signatures collected)`);
    }
    /**
     * Create a deterministic message for signing.
     * Must be consistent across all servers to ensure valid multi-sig.
     */
    createSignatureMessage(currency, rate, source) {
        return `SF-PRICE-${currency}-${rate}-${source}`;
    }
}
// Export singleton instance
export const multiSigService = new MultiSigService();
//# sourceMappingURL=multiSigService.js.map