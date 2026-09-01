import { Address, xdr } from "@stellar/stellar-sdk";

import { logger } from "../../utils/logger";
import type {
  GasMetrics,
  GasSampleSource,
  TrackedTxType,
} from "./gasMetrics.types";
import { classifyTxType } from "./txTypeClassifier";

/**
 * Extracts CPU instruction counts and fee/storage metrics from a Soroban
 * transaction result (Issue #786).
 *
 * Where each value comes from:
 * - CPU instructions, disk reads and writes: the envelope's
 *   `SorobanTransactionData.resources`, which is what the network metered and
 *   charged against.
 * - Total fee: `TransactionResult.feeCharged`.
 * - Storage rent and the refundable/non-refundable split:
 *   `SorobanTransactionMetaExtV1`, present on meta v3 and v4. Older meta
 *   versions and classic transactions simply omit it, so those fields fall
 *   back to zero rather than failing the extraction.
 */

/** Shape of the subset of `rpc.Server.getTransaction` we read. */
export interface TransactionResultLike {
  txHash?: string;
  status?: string;
  ledger?: number;
  createdAt?: number;
  envelopeXdr?: xdr.TransactionEnvelope;
  resultXdr?: xdr.TransactionResult;
  resultMetaXdr?: xdr.TransactionMeta;
}

export interface ExtractOptions {
  txHash?: string;
  source?: GasSampleSource;
  aliases?: Record<string, TrackedTxType>;
}

/** Fee split reported by the ledger, all zero when the extension is absent. */
interface ResourceFeeBreakdown {
  nonRefundableFeeStroops: bigint;
  refundableFeeStroops: bigint;
  rentFeeStroops: bigint;
}

const ZERO_BREAKDOWN: ResourceFeeBreakdown = {
  nonRefundableFeeStroops: 0n,
  refundableFeeStroops: 0n,
  rentFeeStroops: 0n,
};

/** js-xdr Int64/Uint64 values expose `toBigInt()`; guard for hand-built fixtures. */
function toBigInt(value: unknown): bigint {
  if (typeof value === "bigint") return value;
  if (typeof value === "number") return BigInt(Math.trunc(value));

  const candidate = value as {
    toBigInt?: () => bigint;
    toString?: () => string;
  };

  if (typeof candidate?.toBigInt === "function") return candidate.toBigInt();
  if (typeof candidate?.toString === "function") {
    try {
      return BigInt(candidate.toString());
    } catch {
      return 0n;
    }
  }

  return 0n;
}

/**
 * Unwraps a fee-bump envelope to the inner transaction, since the Soroban data
 * and operations live on the inner transaction, not the wrapper.
 */
function resolveInnerTransaction(
  envelope: xdr.TransactionEnvelope | undefined,
): xdr.Transaction | null {
  if (!envelope) return null;

  try {
    switch (envelope.switch().name) {
      case "envelopeTypeTx":
        return envelope.v1().tx();
      case "envelopeTypeTxFeeBump":
        return envelope.feeBump().tx().innerTx().v1().tx();
      // envelopeTypeTxV0 predates Soroban, so it carries no resource data.
      default:
        return null;
    }
  } catch {
    return null;
  }
}

function extractSorobanData(
  tx: xdr.Transaction | null,
): xdr.SorobanTransactionData | null {
  if (!tx) return null;

  try {
    const ext = tx.ext();
    // switch 0 is a classic transaction with no Soroban resources attached.
    return ext.switch() === 1 ? ext.sorobanData() : null;
  } catch {
    return null;
  }
}

/** Reads the invoked contract and function name from the first invokeHostFunction op. */
function extractInvocation(tx: xdr.Transaction | null): {
  contractId: string | null;
  functionName: string | null;
} {
  const empty = { contractId: null, functionName: null };
  if (!tx) return empty;

  try {
    for (const operation of tx.operations()) {
      const body = operation.body();
      if (body.switch().name !== "invokeHostFunction") continue;

      const hostFunction = body.invokeHostFunctionOp().hostFunction();
      if (hostFunction.switch().name !== "hostFunctionTypeInvokeContract") {
        // Contract creation and WASM upload carry no callable function name.
        continue;
      }

      const args = hostFunction.invokeContract();

      return {
        contractId: Address.fromScAddress(args.contractAddress()).toString(),
        functionName: args.functionName().toString(),
      };
    }
  } catch (error) {
    logger.warn("[GasProfiler] Failed to decode invoked function", {
      error: error instanceof Error ? error.message : String(error),
    });
  }

  return empty;
}

/**
 * Reads the resource fee breakdown from meta v3 or v4.
 *
 * v3 carries `SorobanTransactionMeta` and v4 carries `SorobanTransactionMetaV2`;
 * both expose the same `ext()` union, so the extension is read identically.
 */
export function extractResourceFeeBreakdown(
  meta: xdr.TransactionMeta | undefined,
): ResourceFeeBreakdown {
  if (!meta) return ZERO_BREAKDOWN;

  try {
    const version = meta.switch();
    const sorobanMeta =
      version === 3
        ? meta.v3().sorobanMeta()
        : version === 4
          ? meta.v4().sorobanMeta()
          : null;

    if (!sorobanMeta) return ZERO_BREAKDOWN;

    const ext = sorobanMeta.ext();
    if (ext.switch() !== 1) return ZERO_BREAKDOWN;

    const v1 = ext.v1();

    return {
      nonRefundableFeeStroops: toBigInt(
        v1.totalNonRefundableResourceFeeCharged(),
      ),
      refundableFeeStroops: toBigInt(v1.totalRefundableResourceFeeCharged()),
      rentFeeStroops: toBigInt(v1.rentFeeCharged()),
    };
  } catch (error) {
    logger.warn("[GasProfiler] Failed to decode resource fee breakdown", {
      error: error instanceof Error ? error.message : String(error),
    });
    return ZERO_BREAKDOWN;
  }
}

/**
 * Builds a `GasMetrics` sample from a transaction result.
 *
 * Returns `null` when the transaction carries no Soroban resource data — a
 * classic payment or a `manageData` price update has no CPU metering to report,
 * and recording zeroes for it would skew the daily averages.
 */
export function extractGasMetrics(
  response: TransactionResultLike,
  options: ExtractOptions = {},
): GasMetrics | null {
  const txHash = options.txHash ?? response.txHash;
  if (!txHash) {
    logger.warn("[GasProfiler] Skipping sample with no transaction hash");
    return null;
  }

  const innerTx = resolveInnerTransaction(response.envelopeXdr);
  const sorobanData = extractSorobanData(innerTx);

  if (!sorobanData) return null;

  let resources: xdr.SorobanResources;
  try {
    resources = sorobanData.resources();
  } catch {
    return null;
  }

  const { contractId, functionName } = extractInvocation(innerTx);
  const breakdown = extractResourceFeeBreakdown(response.resultMetaXdr);

  const feeChargedStroops = response.resultXdr
    ? toBigInt(response.resultXdr.feeCharged())
    : 0n;

  const createdAt = response.createdAt;

  return {
    txHash,
    txType: classifyTxType(functionName, options.aliases ?? {}),
    contractId,
    functionName,
    successful: response.status !== "FAILED",
    cpuInstructions: resources.instructions(),
    diskReadBytes: resources.diskReadBytes(),
    writeBytes: resources.writeBytes(),
    resourceFeeStroops: toBigInt(sorobanData.resourceFee()),
    feeChargedStroops,
    ...breakdown,
    ledgerSeq: response.ledger ?? 0,
    // RPC reports createdAt in unix seconds.
    occurredAt:
      typeof createdAt === "number" && Number.isFinite(createdAt)
        ? new Date(createdAt * 1000)
        : new Date(),
    source: options.source ?? "backfill",
  };
}
