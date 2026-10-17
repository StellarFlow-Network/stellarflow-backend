import {
  BASE_FEE,
  FeeBumpTransaction,
  SorobanDataBuilder,
  Transaction,
  TransactionBuilder,
  rpc as SorobanRpc,
  xdr,
} from "@stellar/stellar-sdk";
import stellarProvider from "../lib/stellarProvider";
import { getStellarNetworkPassphrase } from "../lib/stellarNetwork";
import { logger } from "../utils/logger";
import { feeEstimationService } from "./feeEstimationService";

const STROOPS_PER_XLM = 10_000_000;
const MAX_RESOURCE_FEE_BUFFER_PERCENT = 100;

export type SorobanFeePriority = "low" | "medium" | "urgent";

export const SOROBAN_FEE_PRIORITIES: readonly SorobanFeePriority[] = [
  "low",
  "medium",
  "urgent",
];

export interface SorobanFeeEnvelopeRequest {
  /** Base64-encoded Stellar transaction envelope to build a fee envelope for. */
  transaction: string;
  /** Priority tier used to derive the inclusion (tip) fee. Defaults to `medium`. */
  priority?: SorobanFeePriority;
  /** Extra safety margin applied on top of the simulated resource fee. Defaults to `0`. */
  resourceFeeBufferPercent?: number;
}

export interface SorobanResourceFootprint {
  /** Simulated CPU instructions consumed by the host. */
  instructions: string;
  /** Simulated host memory bytes consumed (0 when not reported by the RPC). */
  memoryBytes: string;
  /** Number of ledger entries read (footprint read-only + read-write). */
  readEntries: number;
  /** Number of ledger entries written (footprint read-write). */
  writeEntries: number;
  /** Bytes read from the ledger. */
  readBytes: string;
  /** Bytes written to the ledger. */
  writeBytes: string;
}

export interface SorobanFeeBreakdown {
  /** Inclusion (classic) fee charged per operation, charged separately from resources. */
  baseFeePerOperation: string;
  /** Number of operations in the transaction. */
  operationCount: number;
  /** Total inclusion fee (base fee per operation plus any priority tip). */
  inclusionFee: string;
  /** Priority tip added to the inclusion fee for the requested tier. */
  priorityFee: string;
  /** Minimum resource fee returned by the simulation. */
  minResourceFee: string;
  /** Safety buffer added to the resource fee. */
  resourceFeeBuffer: string;
  /** Resource fee written into the returned envelope's Soroban data. */
  resourceFee: string;
  /** Total fee written into the returned envelope (inclusion + resource). */
  totalFee: string;
  /** Total fee expressed in XLM. */
  totalFeeXlm: string;
}

export interface SorobanFeeEnvelopeTiming {
  simulationMs: number;
  assemblyMs: number;
  totalMs: number;
}

export interface SorobanFeeEnvelopeResult {
  /** `restore_required` means ledger entries must be restored before this envelope is valid. */
  status: "success" | "restore_required";
  network: string;
  networkPassphrase: string;
  latestLedger: number;
  priority: SorobanFeePriority;
  /**
   * Ready-to-sign base64 transaction envelope. `null` when `status` is
   * `restore_required` because a restoration transaction must be submitted first.
   */
  envelopeXdr: string | null;
  /** Hex-encoded hash of the returned envelope (`null` when no envelope is returned). */
  transactionHash: string | null;
  footprint: SorobanResourceFootprint;
  fees: SorobanFeeBreakdown;
  /** Present only when `status` is `restore_required`. */
  restorePreamble?: {
    transactionDataXdr: string;
    minResourceFee: string;
  };
  timing: SorobanFeeEnvelopeTiming;
}

export class SorobanFeeEnvelopeError extends Error {
  readonly code: string;
  readonly status: number;
  readonly details: string | undefined;

  constructor(code: string, status: number, message: string, details?: string) {
    super(message);
    this.name = "SorobanFeeEnvelopeError";
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

function toXlm(stroops: bigint): string {
  return (Number(stroops) / STROOPS_PER_XLM).toFixed(7);
}

function divider(operationCount: bigint): bigint {
  return operationCount > 0n ? operationCount : 1n;
}

function ceilDiv(value: bigint, divisor: bigint): bigint {
  const d = divider(divisor);
  return (value + d - 1n) / d;
}

function extractFootprint(
  resources: xdr.SorobanResources,
  memoryBytes: string,
): SorobanResourceFootprint {
  const footprint = resources.footprint();
  const readOnly = footprint.readOnly();
  const readWrite = footprint.readWrite();

  return {
    instructions: String(resources.instructions()),
    memoryBytes,
    readEntries: readOnly.length + readWrite.length,
    writeEntries: readWrite.length,
    readBytes: String(resources.diskReadBytes()),
    writeBytes: String(resources.writeBytes()),
  };
}

function readMemoryBytes(simulation: unknown): string {
  const cost = (simulation as { cost?: { memBytes?: unknown } }).cost;
  const value = cost?.memBytes;
  if (typeof value === "string" || typeof value === "number") {
    return String(value);
  }
  return "0";
}

function sorobanDataFromEnvelope(
  transaction: Transaction,
): xdr.SorobanTransactionData | null {
  const value = transaction.toEnvelope().v1().tx().ext().value();
  return value instanceof xdr.SorobanTransactionData ? value : null;
}

function normalizeBufferPercent(value: unknown): number {
  if (value === undefined || value === null) {
    return 0;
  }
  const parsed = Number(value);
  if (
    !Number.isFinite(parsed) ||
    parsed < 0 ||
    parsed > MAX_RESOURCE_FEE_BUFFER_PERCENT
  ) {
    throw new SorobanFeeEnvelopeError(
      "VALIDATION_ERROR",
      400,
      `'resourceFeeBufferPercent' must be a number between 0 and ${MAX_RESOURCE_FEE_BUFFER_PERCENT}.`,
    );
  }
  return parsed;
}

function normalizePriority(value: unknown): SorobanFeePriority {
  if (value === undefined || value === null) {
    return "medium";
  }
  const parsed = String(value).toLowerCase();
  if (!SOROBAN_FEE_PRIORITIES.includes(parsed as SorobanFeePriority)) {
    throw new SorobanFeeEnvelopeError(
      "VALIDATION_ERROR",
      400,
      `'priority' must be one of: ${SOROBAN_FEE_PRIORITIES.join(", ")}.`,
    );
  }
  return parsed as SorobanFeePriority;
}

export class SorobanFeeEnvelopeService {
  /**
   * Simulates a proposed transaction on Soroban RPC, unpacks its resource
   * footprint, and returns a ready-to-sign envelope with optimal fee settings.
   */
  async buildEnvelope(
    request: SorobanFeeEnvelopeRequest,
  ): Promise<SorobanFeeEnvelopeResult> {
    const startedAt = Date.now();
    const priority = normalizePriority(request.priority);
    const bufferPercent = normalizeBufferPercent(
      request.resourceFeeBufferPercent,
    );

    const transaction = this.parseTransaction(request.transaction);
    const operationCount = BigInt(transaction.operations.length);

    const rpcServer = stellarProvider.getRpcServer();
    const simulationStartedAt = Date.now();
    const simulation = await rpcServer.simulateTransaction(transaction);
    const simulationMs = Date.now() - simulationStartedAt;

    if (SorobanRpc.Api.isSimulationError(simulation)) {
      throw new SorobanFeeEnvelopeError(
        "SIMULATION_FAILED",
        422,
        "Transaction simulation failed; the envelope cannot be built.",
        simulation.error,
      );
    }

    const isRestore = SorobanRpc.Api.isSimulationRestore(simulation);
    const simData = isRestore
      ? simulation.restorePreamble.transactionData
      : simulation.transactionData;
    const resources = simData.build().resources();
    const minResourceFee = BigInt(
      isRestore
        ? simulation.restorePreamble.minResourceFee
        : simulation.minResourceFee,
    );

    const footprint = extractFootprint(resources, readMemoryBytes(simulation));

    const feeEstimate = await feeEstimationService.getFeeEstimate();
    const priorityTier = feeEstimate[priority];
    const priorityFee = BigInt(
      Math.max(0, Math.ceil(Number.isFinite(priorityTier) ? priorityTier : 0)),
    );
    const baseFeePerOperation = BigInt(BASE_FEE);
    const inclusionFee = baseFeePerOperation * operationCount + priorityFee;

    const bufferStroops =
      (minResourceFee * BigInt(Math.round(bufferPercent))) / 100n;
    const resourceFee = minResourceFee + bufferStroops;

    const assemblyStartedAt = Date.now();
    const envelope = isRestore
      ? null
      : this.assembleEnvelope(
          transaction,
          simulation,
          inclusionFee,
          resourceFee,
          operationCount,
        );
    const assemblyMs = Date.now() - assemblyStartedAt;

    const envelopeSorobanData = envelope
      ? sorobanDataFromEnvelope(envelope)
      : null;
    const actualResourceFee = envelopeSorobanData
      ? BigInt(envelopeSorobanData.resourceFee().toString())
      : resourceFee;
    const totalFee = envelope
      ? BigInt(envelope.fee)
      : inclusionFee + resourceFee;
    const actualInclusionFee = totalFee - actualResourceFee;

    const fees: SorobanFeeBreakdown = {
      baseFeePerOperation: baseFeePerOperation.toString(),
      operationCount: Number(operationCount),
      inclusionFee: actualInclusionFee.toString(),
      priorityFee: priorityFee.toString(),
      minResourceFee: minResourceFee.toString(),
      resourceFeeBuffer: bufferStroops.toString(),
      resourceFee: actualResourceFee.toString(),
      totalFee: totalFee.toString(),
      totalFeeXlm: toXlm(totalFee),
    };

    const result: SorobanFeeEnvelopeResult = {
      status: isRestore ? "restore_required" : "success",
      network: process.env.STELLAR_NETWORK ?? "TESTNET",
      networkPassphrase: getStellarNetworkPassphrase(),
      latestLedger: simulation.latestLedger,
      priority,
      envelopeXdr: envelope ? envelope.toXDR() : null,
      transactionHash: envelope ? envelope.hash().toString("hex") : null,
      footprint,
      fees,
      timing: {
        simulationMs,
        assemblyMs,
        totalMs: Date.now() - startedAt,
      },
    };

    if (isRestore) {
      result.restorePreamble = {
        transactionDataXdr: simData.build().toXDR("base64"),
        minResourceFee: simulation.restorePreamble.minResourceFee,
      };
    }

    logger.debug("[SorobanFeeEnvelopeService] Built fee envelope", {
      status: result.status,
      totalFee: fees.totalFee,
      priority,
      timingMs: result.timing.totalMs,
    });

    return result;
  }

  private parseTransaction(transactionXdr: string): Transaction {
    if (
      typeof transactionXdr !== "string" ||
      transactionXdr.trim().length === 0
    ) {
      throw new SorobanFeeEnvelopeError(
        "VALIDATION_ERROR",
        400,
        "A base64-encoded 'transaction' envelope is required.",
      );
    }

    let parsed: Transaction | FeeBumpTransaction;
    try {
      parsed = TransactionBuilder.fromXDR(
        transactionXdr,
        getStellarNetworkPassphrase(),
      );
    } catch (error: unknown) {
      const message =
        error instanceof Error
          ? error.message
          : "Unable to decode the envelope";
      throw new SorobanFeeEnvelopeError(
        "INVALID_TRANSACTION",
        400,
        "The provided 'transaction' is not a valid base64 transaction envelope.",
        message,
      );
    }

    if (parsed instanceof FeeBumpTransaction) {
      throw new SorobanFeeEnvelopeError(
        "UNSUPPORTED_TRANSACTION",
        400,
        "Fee-bump envelopes are not supported. Submit the inner transaction instead.",
      );
    }

    return parsed;
  }

  private assembleEnvelope(
    transaction: Transaction,
    simulation: SorobanRpc.Api.SimulateTransactionSuccessResponse,
    inclusionFee: bigint,
    resourceFee: bigint,
    operationCount: bigint,
  ): Transaction {
    const assembled = SorobanRpc.assembleTransaction(
      transaction,
      simulation,
    ).build();

    const existingSorobanData = sorobanDataFromEnvelope(assembled);
    const finalSorobanData = new SorobanDataBuilder(
      existingSorobanData ?? undefined,
    )
      .setResourceFee(resourceFee)
      .build();

    const options: TransactionBuilder.TransactionBuilderOptions = {
      fee: ceilDiv(inclusionFee, operationCount).toString(),
      sorobanData: finalSorobanData,
      networkPassphrase: transaction.networkPassphrase,
    };

    return TransactionBuilder.cloneFrom(assembled, options).build();
  }
}

export const sorobanFeeEnvelopeService = new SorobanFeeEnvelopeService();
