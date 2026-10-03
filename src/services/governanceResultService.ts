/**
 * Governance Result Service
 *
 * Builds the immutable snapshot of a governance proposal's final vote result
 * (tally + voter address list + individual weight records) and reads the
 * stored snapshot metadata for the proposal detail route.
 *
 * The snapshot is deterministic: identical inputs always serialize to the
 * exact same bytes, so its SHA-256 hash and the IPFS CID derived from it are
 * stable and independently verifiable.
 */

import crypto from "crypto";
import prisma from "../lib/prisma";

export const RESULT_SNAPSHOT_SCHEMA =
  "stellarflow.governance.proposal_result_snapshot";
export const RESULT_SNAPSHOT_VERSION = 1;

// ─── Types ────────────────────────────────────────────────────────────────────

/** Weight as produced by Prisma (Decimal) or by a test fixture (string). */
type WeightLike = string | { toString(): string };

export interface GovernanceVoteRecord {
  accountId: string;
  choice: string;
  weight: WeightLike;
  votedAt: Date | string;
  txHash?: string | null;
}

export interface SnapshotProposalInput {
  proposalId: string;
  contractId: string;
  title?: string | null;
  actionType?: string | null;
  status: string;
  expiresAt: Date | string;
  queuedAt?: Date | string | null;
  executedAt?: Date | string | null;
  cancelledAt?: Date | string | null;
  transactionHash?: string | null;
}

export interface ChoiceTally {
  votes: number;
  weight: string;
}

export interface VoteTally {
  totalVoters: number;
  totalWeight: string;
  /** Keyed by choice label, inserted in sorted order for stable output. */
  byChoice: Record<string, ChoiceTally>;
}

export interface SnapshotVoter {
  accountId: string;
  choice: string;
  weight: string;
  votedAt: string;
  txHash: string | null;
}

export interface GovernanceResultSnapshot {
  schema: string;
  version: number;
  generatedAt: string;
  proposal: {
    proposalId: string;
    contractId: string;
    title: string | null;
    actionType: string | null;
    status: string;
    expiresAt: string;
    queuedAt: string | null;
    executedAt: string | null;
    cancelledAt: string | null;
    transactionHash: string | null;
  };
  tally: VoteTally;
  voters: SnapshotVoter[];
}

export interface ResultExportMetadata {
  cid: string;
  contentHash: string | null;
  exportedAt: string | null;
}

export interface ProposalResultDetail {
  proposal: {
    proposalId: string;
    contractId: string;
    title: string | null;
    actionType: string | null;
    status: string;
    expiresAt: string;
    queuedAt: string | null;
    executedAt: string | null;
    cancelledAt: string | null;
    transactionHash: string | null;
    createdAt: string;
    updatedAt: string;
  };
  tally: VoteTally;
  voterCount: number;
  /** Null until the export worker has published the snapshot to IPFS. */
  resultExport: ResultExportMetadata | null;
}

/** Row shape read from the `GovernanceProposal` table with its votes. */
export interface GovernanceProposalWithVotes {
  proposalId: string;
  contractId: string;
  title: string | null;
  actionType: string | null;
  status: string;
  expiresAt: Date;
  queuedAt: Date | null;
  executedAt: Date | null;
  cancelledAt: Date | null;
  transactionHash: string | null;
  createdAt: Date;
  updatedAt: Date;
  resultExportCid?: string | null;
  resultExportContentHash?: string | null;
  resultExportedAt?: Date | null;
  votes: GovernanceVoteRecord[];
}

// ─── Weight arithmetic (exact, fixed-point) ───────────────────────────────────

interface ScaledWeight {
  units: bigint;
  scale: number;
}

/**
 * Decimal.toString() switches to exponential notation for very small or very
 * large magnitudes; expand it so the plain decimal parser below always sees a
 * plain decimal string.
 */
function expandExponential(text: string): string {
  const match = /^(-?)(\d+)(?:\.(\d+))?[eE]([+-]?\d+)$/.exec(text);
  if (!match) return text;

  const sign = match[1] ?? "";
  const whole = match[2] ?? "0";
  const fraction = match[3] ?? "";
  const exponent = Number(match[4] ?? "0");
  const digits = `${whole}${fraction}`;
  const pointPosition = whole.length + exponent;

  if (pointPosition <= 0) {
    return `${sign}0.${"0".repeat(-pointPosition)}${digits}`;
  }
  if (pointPosition >= digits.length) {
    return `${sign}${digits}${"0".repeat(pointPosition - digits.length)}`;
  }
  return `${sign}${digits.slice(0, pointPosition)}.${digits.slice(pointPosition)}`;
}

function toScaledWeight(value: WeightLike): ScaledWeight {
  const text = expandExponential(value.toString().trim());
  const match = /^(-?)(\d+)(?:\.(\d+))?$/.exec(text);
  if (!match) {
    throw new Error(`Invalid vote weight: "${text}"`);
  }

  const sign = match[1] === "-" ? -1n : 1n;
  const whole = match[2] ?? "0";
  const fraction = match[3] ?? "";
  // BigInt rejects leading zeros, so strip them from the concatenated digits.
  const digits = `${whole}${fraction}`.replace(/^0+(?=\d)/, "");
  const units = BigInt(digits.length > 0 ? digits : "0");

  return { units: sign * units, scale: fraction.length };
}

function scaleUp(units: bigint, from: number, to: number): bigint {
  return from === to ? units : units * 10n ** BigInt(to - from);
}

function formatScaled(units: bigint, scale: number): string {
  if (scale === 0) return units.toString();

  const negative = units < 0n;
  const digits = (negative ? -units : units)
    .toString()
    .padStart(scale + 1, "0");
  const whole = digits.slice(0, digits.length - scale);
  const fraction = digits.slice(digits.length - scale).replace(/0+$/, "");
  const body = fraction.length > 0 ? `${whole}.${fraction}` : whole;
  return negative ? `-${body}` : body;
}

// ─── Tally ────────────────────────────────────────────────────────────────────

/**
 * Aggregates the individual weight records into the final tally.
 *
 * Weights are summed with arbitrary precision at the widest scale present in
 * the input, so no precision is ever lost.
 */
export function computeVoteTally(votes: GovernanceVoteRecord[]): VoteTally {
  const scaledVotes = votes.map((vote) => ({
    choice: vote.choice,
    ...toScaledWeight(vote.weight),
  }));

  let scale = 0;
  for (const vote of scaledVotes) {
    if (vote.scale > scale) scale = vote.scale;
  }

  let totalUnits = 0n;
  const unitsByChoice = new Map<string, { units: bigint; votes: number }>();

  for (const vote of scaledVotes) {
    const units = scaleUp(vote.units, vote.scale, scale);
    totalUnits += units;
    const entry = unitsByChoice.get(vote.choice) ?? { units: 0n, votes: 0 };
    entry.units += units;
    entry.votes += 1;
    unitsByChoice.set(vote.choice, entry);
  }

  const byChoice: Record<string, ChoiceTally> = {};
  for (const choice of [...unitsByChoice.keys()].sort()) {
    const entry = unitsByChoice.get(choice);
    if (!entry) continue;
    byChoice[choice] = {
      votes: entry.votes,
      weight: formatScaled(entry.units, scale),
    };
  }

  return {
    totalVoters: votes.length,
    totalWeight: formatScaled(totalUnits, scale),
    byChoice,
  };
}

// ─── Snapshot ─────────────────────────────────────────────────────────────────

function toIso(value: Date | string): string {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new Error(`Invalid date in governance result: "${String(value)}"`);
  }
  return date.toISOString();
}

function toNullableIso(value: Date | string | null | undefined): string | null {
  return value === null || value === undefined ? null : toIso(value);
}

function compareStrings(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

function normalizeVotes(votes: GovernanceVoteRecord[]): SnapshotVoter[] {
  return [...votes]
    .sort(
      (a, b) =>
        compareStrings(a.accountId, b.accountId) ||
        compareStrings(toIso(a.votedAt), toIso(b.votedAt)),
    )
    .map((vote) => ({
      accountId: vote.accountId,
      choice: vote.choice,
      weight: vote.weight.toString().trim(),
      votedAt: toIso(vote.votedAt),
      txHash: vote.txHash ?? null,
    }));
}

/**
 * Builds the canonical snapshot document for a proposal's final result.
 * Voters are sorted so the serialization is byte-for-byte reproducible.
 */
export function buildGovernanceResultSnapshot(
  proposal: SnapshotProposalInput,
  votes: GovernanceVoteRecord[],
  generatedAt: Date = new Date(),
): GovernanceResultSnapshot {
  return {
    schema: RESULT_SNAPSHOT_SCHEMA,
    version: RESULT_SNAPSHOT_VERSION,
    generatedAt: toIso(generatedAt),
    proposal: {
      proposalId: proposal.proposalId,
      contractId: proposal.contractId,
      title: proposal.title ?? null,
      actionType: proposal.actionType ?? null,
      status: proposal.status,
      expiresAt: toIso(proposal.expiresAt),
      queuedAt: toNullableIso(proposal.queuedAt),
      executedAt: toNullableIso(proposal.executedAt),
      cancelledAt: toNullableIso(proposal.cancelledAt),
      transactionHash: proposal.transactionHash ?? null,
    },
    tally: computeVoteTally(votes),
    voters: normalizeVotes(votes),
  };
}

/** Serializes a snapshot to its canonical UTF-8 JSON representation. */
export function serializeGovernanceResultSnapshot(
  snapshot: GovernanceResultSnapshot,
): Buffer {
  return Buffer.from(JSON.stringify(snapshot), "utf8");
}

/** SHA-256 of the canonical bytes, hex encoded. */
export function sha256Hex(content: Buffer): string {
  return crypto.createHash("sha256").update(content).digest("hex");
}

// ─── Proposal detail query ────────────────────────────────────────────────────

/**
 * Reads a proposal with its votes for the proposal detail route.
 * Returns null when the proposal does not exist.
 */
export async function getProposalResultDetail(
  proposalId: string,
): Promise<ProposalResultDetail | null> {
  const row = await prisma.governanceProposal.findUnique({
    where: { proposalId },
    include: {
      votes: { orderBy: [{ accountId: "asc" }, { votedAt: "asc" }] },
    },
  });

  if (!row) return null;

  const proposal = row as GovernanceProposalWithVotes;
  const cid = proposal.resultExportCid ?? null;

  return {
    proposal: {
      proposalId: proposal.proposalId,
      contractId: proposal.contractId,
      title: proposal.title ?? null,
      actionType: proposal.actionType ?? null,
      status: proposal.status,
      expiresAt: toIso(proposal.expiresAt),
      queuedAt: toNullableIso(proposal.queuedAt),
      executedAt: toNullableIso(proposal.executedAt),
      cancelledAt: toNullableIso(proposal.cancelledAt),
      transactionHash: proposal.transactionHash ?? null,
      createdAt: toIso(proposal.createdAt),
      updatedAt: toIso(proposal.updatedAt),
    },
    tally: computeVoteTally(proposal.votes),
    voterCount: proposal.votes.length,
    resultExport: cid
      ? {
          cid,
          contentHash: proposal.resultExportContentHash ?? null,
          exportedAt: toNullableIso(proposal.resultExportedAt),
        }
      : null,
  };
}
