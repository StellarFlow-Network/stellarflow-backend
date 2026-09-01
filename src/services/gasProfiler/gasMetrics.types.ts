/**
 * Gas and CPU instruction profiling types (Issue #786).
 */

/** Core protocol transaction types we track cost for, plus a catch-all. */
export const TRACKED_TX_TYPES = ["swap", "deposit", "withdraw"] as const;

export type TrackedTxType = (typeof TRACKED_TX_TYPES)[number];

/** `other` covers invoked functions outside the tracked set; `unknown` means we could not classify. */
export type TxType = TrackedTxType | "other" | "unknown";

/** Where a sample came from, so backfill and live submission can be told apart. */
export type GasSampleSource = "submission" | "backfill";

/**
 * A single transaction's resource consumption.
 *
 * Instruction counts and byte counts are `uint32` in the XDR, so they are
 * carried as `number`. Fees are `int64` stroops and are carried as `bigint` to
 * avoid precision loss; the persistence layer widens them to `Decimal`.
 */
export interface GasMetrics {
  txHash: string;
  txType: TxType;
  contractId: string | null;
  functionName: string | null;
  successful: boolean;
  /** CPU instructions the transaction declared/consumed. */
  cpuInstructions: number;
  diskReadBytes: number;
  writeBytes: number;
  /** Resource fee declared in the envelope's Soroban data. */
  resourceFeeStroops: bigint;
  /** Total fee actually charged, from the transaction result. */
  feeChargedStroops: bigint;
  /** Non-refundable portion of the resource fee, when the ledger reported it. */
  nonRefundableFeeStroops: bigint;
  /** Refunded portion of the resource fee, when the ledger reported it. */
  refundableFeeStroops: bigint;
  /** Storage rent charged — the storage fee metric in the acceptance criteria. */
  rentFeeStroops: bigint;
  ledgerSeq: number;
  occurredAt: Date;
  source: GasSampleSource;
}

/** Per-type daily rollup used for cost reporting and spike comparison. */
export interface GasDailyStats {
  day: Date;
  txType: TxType;
  sampleCount: number;
  avgCpuInstructions: number;
  avgFeeChargedStroops: number;
  avgRentFeeStroops: number;
  avgDiskReadBytes: number;
  avgWriteBytes: number;
  maxCpuInstructions: number;
  totalFeeChargedStroops: bigint;
}
