import prisma from "../lib/prisma";
import { signer } from "../signer";
import dotenv from "dotenv";
import axios from "axios";
import { assertSigningAllowed } from "../state/appState";
import { successfulSubmissions, failedSubmissions, gasUsagePerAsset, submissionDuration, } from "../metrics";
dotenv.config();
export class MultiSigService {
    localSignerPublicKey = "";
    signerName;
    SIGNATURE_EXPIRY_MS = 60 * 60 * 1000;
    REQUIRED_SIGNATURES;
    constructor() {
        this.signerName = process.env.ORACLE_SIGNER_NAME || "oracle-server";
        const requiredSignatures = Number.parseInt(process.env.MULTI_SIG_REQUIRED_COUNT || "2", 10);
        this.REQUIRED_SIGNATURES =
            Number.isFinite(requiredSignatures) && requiredSignatures > 0
                ? requiredSignatures
                : 2;
        this.initializeSigner();
    }
    async initializeSigner() {
        this.localSignerPublicKey = await signer.getPublicKey();
    }
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
        const signature = (await signer.sign(Buffer.from(signatureMessage, "utf-8"))).toString("hex");
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
                data: { collectedSignatures: { increment: 1 } },
            });
            console.info(`[MultiSig] Added signature ${updated.collectedSignatures}/${updated.requiredSignatures} for MultiSigPrice ${multiSigPriceId}`);
            if (updated.collectedSignatures >= updated.requiredSignatures) {
                await this.approveMultiSigPrice(multiSigPriceId);
            }
        }
        return { signature, signerPublicKey: this.localSignerPublicKey };
    }
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
            const response = await axios.post(`${remoteServerUrl}/api/v1/price-updates/sign`, payload, {
                headers: {
                    "Content-Type": "application/json",
                    Authorization: `Bearer ${process.env.MULTI_SIG_AUTH_TOKEN || ""}`,
                },
                timeout: 10000,
            });
            const result = response.data;
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
                    data: { collectedSignatures: { increment: 1 } },
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
    async cleanupExpiredRequests() {
        const result = await prisma.multiSigPrice.updateMany({
            where: {
                status: "PENDING",
                expiresAt: { lt: new Date() },
            },
            data: { status: "EXPIRED" },
        });
        if (result.count > 0) {
            console.warn(`[MultiSig] Expired ${result.count} multi-sig price requests`);
        }
        return result.count;
    }
    async getSignatures(multiSigPriceId) {
        return prisma.multiSigSignature.findMany({
            where: { multiSigPriceId },
        });
    }
    /**
     * Mark a multi-sig price as submitted to Stellar.
     * ── INSTRUMENTED ──
     * This is the closest point to an actual Stellar submission in this service.
     * We record success, duration, and fee here because by the time
     * recordSubmission() is called, the tx has already landed on-chain.
     */
    async recordSubmission(multiSigPriceId, memoId, stellarTxHash, asset, // optional — caller can pass e.g. "XLM/USD"
    feeStroops) {
        // Resolve the asset label from DB if not supplied by caller
        const label = asset ?? (await this.resolveCurrency(multiSigPriceId));
        // ── Stop the duration timer (started externally or approximated here) ──
        const endTimer = submissionDuration.startTimer({ asset: label });
        try {
            await prisma.multiSigPrice.update({
                where: { id: multiSigPriceId },
                data: {
                    memoId,
                    stellarTxHash,
                    submittedAt: new Date(),
                },
            });
            // ── Record success ──
            successfulSubmissions.inc({ asset: label });
            // ── Record fee if provided ──
            if (feeStroops !== undefined && feeStroops > 0) {
                gasUsagePerAsset.observe({ asset: label }, feeStroops);
            }
            endTimer();
            console.info(`[MultiSig] MultiSigPrice ${multiSigPriceId} submitted to Stellar - TxHash: ${stellarTxHash}`);
        }
        catch (error) {
            // ── Record failure ──
            const reason = this.classifyError(error);
            failedSubmissions.inc({ asset: label, reason });
            endTimer();
            throw error;
        }
    }
    getLocalSignerInfo() {
        return {
            publicKey: this.localSignerPublicKey,
            name: this.signerName,
        };
    }
    async approveMultiSigPrice(multiSigPriceId) {
        await prisma.multiSigPrice.update({
            where: { id: multiSigPriceId },
            data: { status: "APPROVED" },
        });
        console.info(`[MultiSig] MultiSigPrice ${multiSigPriceId} is now APPROVED (all signatures collected)`);
    }
    createSignatureMessage(currency, rate, source) {
        return `SF-PRICE-${currency}-${rate}-${source}`;
    }
    /** Look up the currency label for a multiSigPrice row. */
    async resolveCurrency(multiSigPriceId) {
        const row = await prisma.multiSigPrice.findUnique({
            where: { id: multiSigPriceId },
            select: { currency: true },
        });
        return row?.currency ?? "unknown";
    }
    /** Map errors to stable Prometheus label values. */
    classifyError(error) {
        if (error instanceof Error) {
            const msg = error.message.toLowerCase();
            if (msg.includes("timeout"))
                return "timeout";
            if (msg.includes("validation"))
                return "validation";
            if (msg.includes("expired"))
                return "expired";
            if (msg.includes("not found"))
                return "not_found";
        }
        return "unknown";
    }
}
export const multiSigService = new MultiSigService();
//# sourceMappingURL=multiSigService.js.map