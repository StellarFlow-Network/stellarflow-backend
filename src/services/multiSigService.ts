import prisma from "../lib/prisma";
import { Keypair } from "@stellar/stellar-sdk";
import dotenv from "dotenv";

dotenv.config();

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

export class MultiSigService {
  private localSignerPublicKey: string;
  private localSignerSecret: string;
  private signerName: string;
  private readonly SIGNATURE_EXPIRY_MS = 3600000; // 1 hour
  private readonly REQUIRED_SIGNATURES = 2; // Default: 2 signatures needed

  constructor() {
    const secret = process.env.ORACLE_SECRET_KEY || process.env.SOROBAN_ADMIN_SECRET;
    if (!secret) {
      throw new Error(
        "ORACLE_SECRET_KEY or SOROBAN_ADMIN_SECRET not found in environment variables"
      );
    }

    this.localSignerSecret = secret;
    this.localSignerPublicKey = Keypair.fromSecret(secret).publicKey();
    this.signerName = process.env.ORACLE_SIGNER_NAME || "oracle-server";

    const requiredSigs = process.env.MULTI_SIG_REQUIRED_COUNT;
    if (requiredSigs) {
      const parsed = parseInt(requiredSigs, 10);
      if (!isNaN(parsed) && parsed > 0) {
        (this as any).REQUIRED_SIGNATURES = parsed;
      }
    }
  }

  /**
   * Create a multi-sig price update request.
   * This initiates the process where the price needs to be signed by multiple servers.
   */
  async createMultiSigRequest(
    priceReviewId: number,
    currency: string,
    rate: number,
    source: string,
    memoId: string
  ): Promise<SignatureRequest> {
    const expiresAt = new Date(Date.now() + this.SIGNATURE_EXPIRY_MS);

    const created = await prisma.multiSigPrice.create({
      data: {
        priceReviewId,
        currency,
        rate,
        source,
        status: "PENDING",
        requiredSignatures: this.REQUIRED_SIGNATURES,
        collectedSignatures: 0,
        expiresAt,
      },
    });

    console.info(
      `[MultiSig] Created signature request ${created.id} for ${currency} rate ${rate}`
    );

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
  async signMultiSigPrice(
    multiSigPriceId: number
  ): Promise<{ signature: string; signerPublicKey: string }> {
    // Fetch the multi-sig price record
    const multiSigPrice = await prisma.multiSigPrice.findUnique({
      where: { id: multiSigPriceId },
    });

    if (!multiSigPrice) {
      throw new Error(`MultiSigPrice ${multiSigPriceId} not found`);
    }

    if (multiSigPrice.status !== "PENDING") {
      throw new Error(
        `Cannot sign MultiSigPrice ${multiSigPriceId} - status is ${multiSigPrice.status}`
      );
    }

    if (new Date() > multiSigPrice.expiresAt) {
      // Mark as expired
      await prisma.multiSigPrice.update({
        where: { id: multiSigPriceId },
        data: { status: "EXPIRED" },
      });
      throw new Error(`MultiSigPrice ${multiSigPriceId} has expired`);
    }

    // Create a deterministic signature message based on the price data
    const signatureMessage = this.createSignatureMessage(
      multiSigPrice.currency,
      multiSigPrice.rate.toString(),
      multiSigPrice.source
    );

    // Sign the message
    const keypair = Keypair.fromSecret(this.localSignerSecret);
    
    // Convert message to buffer and sign
    const messageBuffer = Buffer.from(signatureMessage, "utf-8");
    const signatureBuffer = keypair.sign(messageBuffer);
    const signature = signatureBuffer.toString("hex");

    // Record the signature
    await prisma.multiSigSignature.create({
      data: {
        multiSigPriceId,
        signerPublicKey: this.localSignerPublicKey,
        signerName: this.signerName,
        signature,
      },
    });

    // Increment the collected signatures count
    const updated = await prisma.multiSigPrice.update({
      where: { id: multiSigPriceId },
      data: {
        collectedSignatures: {
          increment: 1,
        },
      },
    });

    console.info(
      `[MultiSig] Added signature ${updated.collectedSignatures}/${updated.requiredSignatures} for MultiSigPrice ${multiSigPriceId}`
    );

    // If we have all required signatures, mark as approved
    if (updated.collectedSignatures >= updated.requiredSignatures) {
      await this.approveMultiSigPrice(multiSigPriceId);
    }

    return { signature, signerPublicKey: this.localSignerPublicKey };
  }

  /**
   * Request a signature from a remote server.
   * Sends an HTTP request to a peer server to sign the price update.
   */
  async requestRemoteSignature(
    multiSigPriceId: number,
    remoteServerUrl: string
  ): Promise<{ success: boolean; error?: string }> {
    try {
      const multiSigPrice = await prisma.multiSigPrice.findUnique({
        where: { id: multiSigPriceId },
      });

      if (!multiSigPrice) {
        return {
          success: false,
          error: `MultiSigPrice ${multiSigPriceId} not found`,
        };
      }

      const payload: SignaturePayload = {
        multiSigPriceId,
        currency: multiSigPrice.currency,
        rate: multiSigPrice.rate.toNumber(),
        source: multiSigPrice.source,
        memoId: multiSigPrice.memoId || "",
        signerPublicKey: this.localSignerPublicKey,
      };

      // Make HTTP request to remote server
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

      const result = await response.json();

      if (result.signature && result.signerPublicKey) {
        // Record the remote signature
        await prisma.multiSigSignature.create({
          data: {
            multiSigPriceId,
            signerPublicKey: result.signerPublicKey,
            signerName: result.signerName || "remote-signer",
            signature: result.signature,
          },
        }).catch((err: any) => {
          // Ignore duplicate signers
          if (err.code !== "P2002") throw err;
        });

        // Increment collected signatures
        const updated = await prisma.multiSigPrice.update({
          where: { id: multiSigPriceId },
          data: {
            collectedSignatures: {
              increment: 1,
            },
          },
        });

        console.info(
          `[MultiSig] Added remote signature ${updated.collectedSignatures}/${updated.requiredSignatures} for MultiSigPrice ${multiSigPriceId}`
        );

        // Check if all signatures are collected
        if (updated.collectedSignatures >= updated.requiredSignatures) {
          await this.approveMultiSigPrice(multiSigPriceId);
        }
      }

      return { success: true };
    } catch (error) {
      console.error(
        `[MultiSig] Failed to request signature from ${remoteServerUrl}:`,
        error
      );
      return { success: false, error: String(error) };
    }
  }

  /**
   * Get a pending multi-sig price by ID.
   * Returns the price details and current signature status.
   */
  async getMultiSigPrice(multiSigPriceId: number): Promise<any> {
    const multiSigPrice = await prisma.multiSigPrice.findUnique({
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

    return multiSigPrice;
  }

  /**
   * Get all pending multi-sig prices.
   * Useful for monitoring and checking expiration.
   */
  async getPendingMultiSigPrices(): Promise<any[]> {
    return await prisma.multiSigPrice.findMany({
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
  async cleanupExpiredRequests(): Promise<number> {
    const now = new Date();
    const result = await prisma.multiSigPrice.updateMany({
      where: {
        status: "PENDING",
        expiresAt: { lt: now },
      },
      data: {
        status: "EXPIRED",
      },
    });

    if (result.count > 0) {
      console.warn(
        `[MultiSig] Expired ${result.count} multi-sig price requests`
      );
    }

    return result.count;
  }

  /**
   * Mark a multi-sig price as approved (all signatures collected).
   * This happens automatically when all required signatures are collected.
   */
  private async approveMultiSigPrice(multiSigPriceId: number): Promise<void> {
    await prisma.multiSigPrice.update({
      where: { id: multiSigPriceId },
      data: {
        status: "APPROVED",
      },
    });

    console.info(
      `[MultiSig] MultiSigPrice ${multiSigPriceId} is now APPROVED (all signatures collected)`
    );
  }

  /**
   * Get all signatures for a multi-sig price.
   * Returns the signatures needed for submitting to Stellar.
   */
  async getSignatures(multiSigPriceId: number): Promise<any[]> {
    const signatures = await prisma.multiSigSignature.findMany({
      where: { multiSigPriceId },
    });

    return signatures;
  }

  /**
   * Mark a multi-sig price as submitted to Stellar.
   * Records the transaction hash and memo ID.
   */
  async recordSubmission(
    multiSigPriceId: number,
    memoId: string,
    stellarTxHash: string
  ): Promise<void> {
    await prisma.multiSigPrice.update({
      where: { id: multiSigPriceId },
      data: {
        memoId,
        stellarTxHash,
        submittedAt: new Date(),
      },
    });

    console.info(
      `[MultiSig] MultiSigPrice ${multiSigPriceId} submitted to Stellar - TxHash: ${stellarTxHash}`
    );
  }

  /**
   * Create a deterministic message for signing.
   * Must be consistent across all servers to ensure valid multi-sig.
   */
  private createSignatureMessage(
    currency: string,
    rate: string,
    source: string
  ): string {
    // Create a deterministic message format
    // Format: "SF-PRICE-<CURRENCY>-<RATE>-<SOURCE>"
    return `SF-PRICE-${currency}-${rate}-${source}`;
  }

  /**
   * Get this server's signer identity.
   */
  getLocalSignerInfo(): {
    publicKey: string;
    name: string;
  } {
    return {
      publicKey: this.localSignerPublicKey,
      name: this.signerName,
    };
  }
}

// Export singleton instance
export const multiSigService = new MultiSigService();
