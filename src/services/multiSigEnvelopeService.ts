import {
  Keypair,
  Transaction,
  xdr,
} from "@stellar/stellar-sdk";
import stellarProvider from "../lib/stellarProvider";
import { getStellarNetworkPassphrase } from "../lib/stellarNetwork";
import { logger } from "../utils/logger";

/**
 * Multi-Sig Transaction Envelope Collector & Relayer Service
 *
 * Collects partial signatures for multi-sig administration accounts before
 * broadcasting a fully signed transaction envelope to Soroban RPC.
 *
 * Flow:
 *   1. A caller submits a base64-encoded transaction envelope (XDR) plus a
 *      signature payload (signer public key + signature).
 *   2. The service validates the signature against the transaction hash and
 *      the signer's public key.
 *   3. Signatures are accumulated per envelope hash until the required
 *      signer threshold is reached.
 *   4. Once the threshold is met, the fully signed envelope is broadcast to
 *      the Soroban RPC server.
 */

interface PendingEnvelope {
  envelopeXdr: string;
  transaction: Transaction;
  signatures: Map<string, string>; // signerPublicKey -> signature (base64)
  requiredSignatures: number;
  createdAt: number;
}

interface SignResult {
  collected: number;
  required: number;
  broadcast: boolean;
  transactionHash?: string;
  envelopeHash?: string;
}

const ENVELOPE_TTL_MS = 10 * 60 * 1000; // 10 minutes
const MAX_SIGNERS = 20;

class MultiSigEnvelopeService {
  private readonly pendingEnvelopes = new Map<string, PendingEnvelope>();
  private readonly networkPassphrase: string;

  constructor() {
    this.networkPassphrase = getStellarNetworkPassphrase();
    // Periodically purge expired envelopes.
    setInterval(() => this.purgeExpired(), 60_000).unref();
  }

  /**
   * Collect a partial signature for a multi-sig administration transaction
   * envelope and, once the required signer threshold is reached, broadcast
   * the fully signed envelope to Soroban RPC.
   *
   * @param envelopeXdr - Base64-encoded transaction envelope (XDR).
   * @param signerPublicKey - Stellar public key of the signer.
   * @param signature - Base64-encoded signature (DecoratedSignature.signature).
   * @param requiredSignatures - Number of signatures required to broadcast.
   */
  async collectSignature(
    envelopeXdr: string,
    signerPublicKey: string,
    signature: string,
    requiredSignatures: number,
  ): Promise<SignResult> {
    // Parse the envelope to derive its hash and validate the XDR.
    const transaction = this.parseEnvelope(envelopeXdr);
    const envelopeHash = transaction.hash().toString("hex");

    // Validate the submitted signature against the transaction hash.
    this.validateSignature(envelopeHash, signerPublicKey, signature);

    let pending = this.pendingEnvelopes.get(envelopeHash);
    if (!pending) {
      pending = {
        envelopeXdr,
        transaction,
        signatures: new Map(),
        requiredSignatures,
        createdAt: Date.now(),
      };
      this.pendingEnvelopes.set(envelopeHash, pending);
    }

    // Reject duplicate signatures from the same signer.
    if (pending.signatures.has(signerPublicKey)) {
      throw new Error(
        `Signature already collected from signer ${signerPublicKey} for envelope ${envelopeHash}`,
      );
    }

    if (pending.signatures.size >= MAX_SIGNERS) {
      throw new Error(`Maximum number of signers (${MAX_SIGNERS}) reached`);
    }

    pending.signatures.set(signerPublicKey, signature);
    logger.info(
      `[MultiSigEnvelope] Collected signature ${pending.signatures.size}/${pending.requiredSignatures} ` +
        `for envelope ${envelopeHash} from ${signerPublicKey}`,
    );

    if (pending.signatures.size < pending.requiredSignatures) {
      return {
        collected: pending.signatures.size,
        required: pending.requiredSignatures,
        broadcast: false,
        envelopeHash,
      };
    }

    // Threshold reached — assemble the fully signed envelope and broadcast.
    const transactionHash = await this.broadcast(pending);
    this.pendingEnvelopes.delete(envelopeHash);

    return {
      collected: pending.signatures.size,
      required: pending.requiredSignatures,
      broadcast: true,
      transactionHash,
      envelopeHash,
    };
  }

  /**
   * Parse a base64-encoded transaction envelope XDR into a Transaction.
   */
  private parseEnvelope(envelopeXdr: string): Transaction {
    let envelope: xdr.TransactionEnvelope;
    try {
      envelope = xdr.TransactionEnvelope.fromXDR(envelopeXdr, "base64");
    } catch (error) {
      throw new Error(
        `Invalid transaction envelope XDR: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    try {
      return new Transaction(envelope, this.networkPassphrase);
    } catch (error) {
      throw new Error(
        `Failed to parse transaction envelope: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /**
   * Validate that the submitted signature is a valid Ed25519 signature over
   * the transaction hash produced by the given signer public key.
   */
  private validateSignature(
    envelopeHash: string,
    signerPublicKey: string,
    signature: string,
  ): void {
    let keypair: Keypair;
    try {
      keypair = Keypair.fromPublicKey(signerPublicKey);
    } catch {
      throw new Error(`Invalid signer public key: ${signerPublicKey}`);
    }

    let signatureBuffer: Buffer;
    try {
      signatureBuffer = Buffer.from(signature, "base64");
    } catch {
      throw new Error("Signature must be base64-encoded");
    }

    const hashBuffer = Buffer.from(envelopeHash, "hex");
    if (!keypair.verify(hashBuffer, signatureBuffer)) {
      throw new Error(
        `Signature verification failed for signer ${signerPublicKey}`,
      );
    }
  }

  /**
   * Assemble the fully signed transaction envelope and broadcast it to the
   * Soroban RPC server. Returns the transaction hash on success.
   */
  private async broadcast(pending: PendingEnvelope): Promise<string> {
    const { transaction, signatures } = pending;

    // Attach all collected signatures to the transaction.
    for (const [publicKey, signature] of signatures) {
      const keypair = Keypair.fromPublicKey(publicKey);
      transaction.signatures.push(
        new xdr.DecoratedSignature({
          hint: keypair.signatureHint(),
          signature: Buffer.from(signature, "base64"),
        }),
      );
    }

    const rpcServer = stellarProvider.getRpcServer();

    // Simulate the transaction to obtain fee/authorization data.
    let prepared = transaction;
    try {
      const simulation = await rpcServer.simulateTransaction(transaction);
      prepared = rpcServer.assembleTransaction(transaction, simulation).build();
    } catch (error) {
      logger.warn(
        `[MultiSigEnvelope] Simulation failed for envelope ${transaction.hash().toString("hex")}: ` +
          `${error instanceof Error ? error.message : String(error)}. Broadcasting raw envelope.`,
      );
    }

    const submitted = await rpcServer.sendTransaction(prepared);
    if (submitted.status === "ERROR" || submitted.status === "FAILED") {
      throw new Error(
        `Transaction submission failed: ${submitted.errorResult?.result().toString() ?? submitted.status}`,
      );
    }

    // Wait for the transaction to be confirmed.
    for (let attempt = 0; attempt < 30; attempt++) {
      const result = await rpcServer.getTransaction(submitted.hash);
      if (result.status === "SUCCESS") {
        logger.info(
          `[MultiSigEnvelope] Transaction ${submitted.hash} confirmed on-chain`,
        );
        return submitted.hash;
      }
      if (result.status === "FAILED") {
        throw new Error(`Transaction ${submitted.hash} failed on-chain`);
      }
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }

    throw new Error(
      `Transaction ${submitted.hash} confirmation timed out`,
    );
  }

  /**
   * Remove envelopes that have exceeded their TTL.
   */
  private purgeExpired(): void {
    const now = Date.now();
    for (const [hash, pending] of this.pendingEnvelopes) {
      if (now - pending.createdAt > ENVELOPE_TTL_MS) {
        this.pendingEnvelopes.delete(hash);
        logger.warn(
          `[MultiSigEnvelope] Purged expired envelope ${hash} (${pending.signatures.size}/${pending.requiredSignatures} signatures)`,
        );
      }
    }
  }
}

export const multiSigEnvelopeService = new MultiSigEnvelopeService();
