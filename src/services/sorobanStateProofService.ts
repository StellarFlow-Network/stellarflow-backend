import { createHash, timingSafeEqual } from "node:crypto";
import { StrKey, xdr } from "@stellar/stellar-sdk";

export type ProofStep = { hash: string; side: "left" | "right" };

export interface VerifySorobanStateProofInput {
  ledgerHeaderXdr: string;
  ledgerEntryXdr: string;
  contractId: string;
  keyXdr: string;
  proof: ProofStep[];
}

export class InvalidLedgerProofError extends Error {
  readonly code = "InvalidLedgerProof";

  constructor(
    message = "The ledger entry proof does not match the ledger header.",
  ) {
    super(message);
    this.name = "InvalidLedgerProofError";
  }
}

function decodeBase64(value: string, field: string): Buffer {
  if (
    !value ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
      value,
    )
  ) {
    throw new InvalidLedgerProofError(`${field} must be valid base64 XDR.`);
  }
  return Buffer.from(value, "base64");
}

function decodeHash(value: string): Buffer {
  if (!/^[0-9a-fA-F]{64}$/.test(value)) {
    throw new InvalidLedgerProofError(
      "Proof sibling hashes must be 32-byte hexadecimal values.",
    );
  }
  return Buffer.from(value, "hex");
}

/** Hash canonical XDR bytes with SHA-256, as used by Stellar ledger objects. */
export function sha256(bytes: Uint8Array): Buffer {
  return createHash("sha256").update(bytes).digest();
}

/** Fold a directional SHA-256 Merkle path over a 32-byte leaf hash. */
export function foldProofPath(leafHash: Buffer, proof: ProofStep[]): Buffer {
  if (leafHash.length !== 32 || proof.length > 256) {
    throw new InvalidLedgerProofError("The proof path is invalid or too deep.");
  }
  return proof.reduce((current, step) => {
    const sibling = decodeHash(step.hash);
    const left = step.side === "left" ? sibling : current;
    const right = step.side === "right" ? sibling : current;
    if (step.side !== "left" && step.side !== "right") {
      throw new InvalidLedgerProofError(
        "Each proof step must specify left or right.",
      );
    }
    return sha256(Buffer.concat([left, right]));
  }, leafHash);
}

export function assertProofRoot(
  expectedRoot: Buffer,
  actualRoot: Buffer,
): void {
  if (
    expectedRoot.length !== 32 ||
    actualRoot.length !== 32 ||
    !timingSafeEqual(expectedRoot, actualRoot)
  ) {
    throw new InvalidLedgerProofError();
  }
}

/** Verify a ContractData ledger entry against a ledger header's bucket-list root. */
export function verifySorobanStateProof(input: VerifySorobanStateProofInput) {
  try {
    if (!input || !Array.isArray(input.proof)) {
      throw new InvalidLedgerProofError("A proof path is required.");
    }
    const headerBytes = decodeBase64(input.ledgerHeaderXdr, "ledgerHeaderXdr");
    const entryBytes = decodeBase64(input.ledgerEntryXdr, "ledgerEntryXdr");
    const keyBytes = decodeBase64(input.keyXdr, "keyXdr");
    const header = xdr.LedgerHeader.fromXDR(headerBytes);
    const entry = xdr.LedgerEntry.fromXDR(entryBytes);

    // A proof for some other ledger entry must not be accepted as contract state.
    const data = entry.data().contractData();
    const requestedKey = xdr.ScVal.fromXDR(keyBytes);
    if (!data.key().toXDR().equals(requestedKey.toXDR())) {
      throw new InvalidLedgerProofError(
        "The proved ledger entry does not match keyXdr.",
      );
    }
    const requestedContract = StrKey.decodeContract(input.contractId);
    const storedContract = Buffer.from(
      data.contract().contractId() as unknown as Uint8Array,
    );
    if (!storedContract.equals(requestedContract)) {
      throw new InvalidLedgerProofError(
        "The proved ledger entry does not match contractId.",
      );
    }

    const expectedRoot = Buffer.from(header.bucketListHash());
    // BucketList hashes live/dead/init BucketEntry XDR, not bare LedgerEntry XDR.
    const bucketEntryBytes = xdr.BucketEntry.liveentry(entry).toXDR();
    const actualRoot = foldProofPath(sha256(bucketEntryBytes), input.proof);
    assertProofRoot(expectedRoot, actualRoot);

    return {
      valid: true as const,
      ledgerSequence: header.ledgerSeq(),
      contractId: input.contractId,
    };
  } catch (error) {
    if (error instanceof InvalidLedgerProofError) throw error;
    throw new InvalidLedgerProofError(
      "The supplied XDR or proof is malformed.",
    );
  }
}
