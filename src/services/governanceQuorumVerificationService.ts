/**
 * DAO Governance Proposal Quorum Verification Service
 *
 * Verifies if active governance proposals have met quorum thresholds before
 * allowing voting completion.
 *
 * Technical Tasks:
 * 1. Calculate total participating vote weight:
 *    V_total = V_for + V_against + V_abstain
 * 2. Check V_total against required proposal quorum threshold Q_required:
 *    Quorum met iff V_total >= Q_required
 * 3. Mark proposals as SUCCEEDED or DEFEATED upon voting period expiration:
 *    - Quorum verification executes automatically when proposal voting periods expire (now >= expiresAt).
 *    - Accurately determines proposal success based on quorum and majority rules:
 *      * If V_total < Q_required -> DEFEATED (Quorum not met)
 *      * If V_total >= Q_required:
 *          - If V_for > V_against -> SUCCEEDED
 *          - If V_for <= V_against -> DEFEATED
 */

import prisma from "../lib/prisma";
import { logger } from "../utils/logger";
import {
  broadcastVoteUpdate,
  broadcastTimelockStatus,
} from "../websockets/governanceWebSocket.service";

// ─── Types ───────────────────────────────────────────────────────────────────

export type VoteChoiceNormalized = "For" | "Against" | "Abstain";
export type ProposalResolutionStatus = "SUCCEEDED" | "DEFEATED";

export type WeightLike = string | number | bigint | { toString(): string };

export interface GovernanceVoteInput {
  accountId?: string;
  choice: string;
  weight: WeightLike;
  votedAt?: Date | string;
  txHash?: string | null;
}

export interface GovernanceProposalInput {
  id?: number;
  proposalId: string;
  contractId?: string;
  title?: string | null;
  actionType?: string | null;
  actionData?: string | null;
  expiresAt: Date | string;
  status: string;
  votes?: GovernanceVoteInput[];
  quorumThreshold?: WeightLike | null;
  requiredQuorum?: WeightLike | null;
}

export interface ProposalVoteBreakdown {
  forWeight: string;
  againstWeight: string;
  abstainWeight: string;
  totalWeight: string;
  forCount: number;
  againstCount: number;
  abstainCount: number;
  totalVoters: number;
}

export interface QuorumVerificationResult {
  proposalId: string;
  contractId?: string;
  quorumRequired: string;
  totalParticipatingWeight: string;
  quorumMet: boolean;
  majorityMet: boolean;
  finalStatus: ProposalResolutionStatus;
  breakdown: ProposalVoteBreakdown;
  reason: string;
  isExpired: boolean;
  evaluatedAt: Date;
}

export interface VerifyProposalOptions {
  quorumThreshold?: WeightLike;
  now?: Date;
  forceResolution?: boolean;
}

export interface GovernanceQuorumServiceOptions {
  prismaClient?: any;
  pollIntervalMs?: number;
  defaultQuorumThreshold?: WeightLike;
  loggerInstance?: typeof logger;
}

// ─── Fixed-Point Arbitrary-Precision Arithmetic Helpers ───────────────────────

interface ScaledWeight {
  units: bigint;
  scale: number;
}

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

export function toScaledWeight(value: WeightLike): ScaledWeight {
  if (typeof value === "bigint") {
    return { units: value, scale: 0 };
  }
  const text = expandExponential(value.toString().trim());
  if (text === "" || text === "NaN") {
    return { units: 0n, scale: 0 };
  }
  const match = /^(-?)(\d+)(?:\.(\d+))?$/.exec(text);
  if (!match) {
    throw new Error(`Invalid vote weight: "${text}"`);
  }

  const sign = match[1] === "-" ? -1n : 1n;
  const whole = match[2] ?? "0";
  const fraction = match[3] ?? "";
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
  const absUnits = negative ? -units : units;
  const digits = absUnits.toString().padStart(scale + 1, "0");
  const whole = digits.slice(0, digits.length - scale);
  const fraction = digits.slice(digits.length - scale).replace(/0+$/, "");
  const body = fraction.length > 0 ? `${whole}.${fraction}` : whole;
  return negative ? `-${body}` : body;
}

// ─── Normalization & Tallying ─────────────────────────────────────────────────

export function normalizeVoteChoice(choice: string): VoteChoiceNormalized | null {
  const normalized = choice.trim().toLowerCase();
  if (["for", "yes", "aye", "1", "approve"].includes(normalized)) {
    return "For";
  }
  if (["against", "no", "nay", "0", "reject"].includes(normalized)) {
    return "Against";
  }
  if (["abstain", "neutral", "pass"].includes(normalized)) {
    return "Abstain";
  }
  return null;
}

/**
 * Calculates total participating vote weight:
 * V_total = V_for + V_against + V_abstain
 */
export function calculateVoteWeights(votes: GovernanceVoteInput[]): {
  breakdown: ProposalVoteBreakdown;
  scaledFor: ScaledWeight;
  scaledAgainst: ScaledWeight;
  scaledAbstain: ScaledWeight;
  scaledTotal: ScaledWeight;
} {
  const scaledVotes: Array<{ choice: VoteChoiceNormalized | null; units: bigint; scale: number }> = [];
  let maxScale = 0;

  for (const vote of votes) {
    const normChoice = normalizeVoteChoice(vote.choice);
    const scaled = toScaledWeight(vote.weight);
    if (scaled.scale > maxScale) {
      maxScale = scaled.scale;
    }
    scaledVotes.push({
      choice: normChoice,
      units: scaled.units,
      scale: scaled.scale,
    });
  }

  let forUnits = 0n;
  let againstUnits = 0n;
  let abstainUnits = 0n;
  let forCount = 0;
  let againstCount = 0;
  let abstainCount = 0;

  for (const vote of scaledVotes) {
    const alignedUnits = scaleUp(vote.units, vote.scale, maxScale);
    if (vote.choice === "For") {
      forUnits += alignedUnits;
      forCount += 1;
    } else if (vote.choice === "Against") {
      againstUnits += alignedUnits;
      againstCount += 1;
    } else if (vote.choice === "Abstain") {
      abstainUnits += alignedUnits;
      abstainCount += 1;
    }
  }

  const totalUnits = forUnits + againstUnits + abstainUnits;
  const totalVoters = forCount + againstCount + abstainCount;

  const breakdown: ProposalVoteBreakdown = {
    forWeight: formatScaled(forUnits, maxScale),
    againstWeight: formatScaled(againstUnits, maxScale),
    abstainWeight: formatScaled(abstainUnits, maxScale),
    totalWeight: formatScaled(totalUnits, maxScale),
    forCount,
    againstCount,
    abstainCount,
    totalVoters,
  };

  return {
    breakdown,
    scaledFor: { units: forUnits, scale: maxScale },
    scaledAgainst: { units: againstUnits, scale: maxScale },
    scaledAbstain: { units: abstainUnits, scale: maxScale },
    scaledTotal: { units: totalUnits, scale: maxScale },
  };
}

/**
 * Extracts the required quorum threshold Q_required from proposal input or configuration.
 */
export function extractRequiredQuorum(
  proposal: GovernanceProposalInput,
  defaultThreshold: WeightLike = "0",
): string {
  if (proposal.quorumThreshold !== undefined && proposal.quorumThreshold !== null) {
    return proposal.quorumThreshold.toString().trim();
  }
  if (proposal.requiredQuorum !== undefined && proposal.requiredQuorum !== null) {
    return proposal.requiredQuorum.toString().trim();
  }

  if (proposal.actionData) {
    try {
      const parsed = typeof proposal.actionData === "string"
        ? JSON.parse(proposal.actionData)
        : proposal.actionData;
      if (parsed && typeof parsed === "object") {
        const candidate =
          parsed.quorumThreshold ??
          parsed.requiredQuorum ??
          parsed.quorum ??
          parsed.threshold;
        if (candidate !== undefined && candidate !== null) {
          return candidate.toString().trim();
        }
      }
    } catch {
      // actionData was not JSON, continue to default
    }
  }

  return defaultThreshold.toString().trim();
}

// ─── Main Service Class ───────────────────────────────────────────────────────

export class GovernanceQuorumVerificationService {
  private readonly db: any;
  private readonly pollIntervalMs: number;
  private readonly defaultQuorumThreshold: string;
  private readonly log: typeof logger;

  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;
  private isProcessing = false;

  constructor(options: GovernanceQuorumServiceOptions = {}) {
    this.db = options.prismaClient ?? prisma;
    this.pollIntervalMs =
      options.pollIntervalMs ??
      (Number(process.env.GOVERNANCE_QUORUM_POLL_INTERVAL_MS) || 15_000);
    this.defaultQuorumThreshold = (
      options.defaultQuorumThreshold ??
      process.env.GOVERNANCE_QUORUM_THRESHOLD ??
      "0"
    ).toString();
    this.log = options.loggerInstance ?? logger;
  }

  /**
   * Evaluates proposal vote weight against quorum threshold and majority rules.
   * Pure evaluation with no database side-effects.
   */
  evaluateProposal(
    proposal: GovernanceProposalInput,
    votes: GovernanceVoteInput[] = proposal.votes ?? [],
    overrideQuorumThreshold?: WeightLike,
    now: Date = new Date(),
  ): QuorumVerificationResult {
    const requiredQuorumStr = overrideQuorumThreshold !== undefined
      ? overrideQuorumThreshold.toString().trim()
      : extractRequiredQuorum(proposal, this.defaultQuorumThreshold);

    const { breakdown, scaledFor, scaledAgainst, scaledTotal } =
      calculateVoteWeights(votes);

    const scaledRequired = toScaledWeight(requiredQuorumStr);

    // Normalize scales to compare V_total >= Q_required and V_for > V_against
    const compareScale = Math.max(
      scaledTotal.scale,
      scaledRequired.scale,
      scaledFor.scale,
      scaledAgainst.scale,
    );

    const totalUnitsAligned = scaleUp(scaledTotal.units, scaledTotal.scale, compareScale);
    const requiredUnitsAligned = scaleUp(scaledRequired.units, scaledRequired.scale, compareScale);
    const forUnitsAligned = scaleUp(scaledFor.units, scaledFor.scale, compareScale);
    const againstUnitsAligned = scaleUp(scaledAgainst.units, scaledAgainst.scale, compareScale);

    // Check 1: Quorum Met (V_total >= Q_required)
    const quorumMet = totalUnitsAligned >= requiredUnitsAligned;

    // Check 2: Majority Met (V_for > V_against)
    const majorityMet = forUnitsAligned > againstUnitsAligned;

    // Determine final status
    const finalStatus: ProposalResolutionStatus =
      quorumMet && majorityMet ? "SUCCEEDED" : "DEFEATED";

    let reason: string;
    if (!quorumMet) {
      reason = `Quorum threshold not met: total participating vote weight ${breakdown.totalWeight} is less than required quorum ${requiredQuorumStr}`;
    } else if (!majorityMet) {
      if (forUnitsAligned === againstUnitsAligned) {
        reason = `Proposal defeated: votes in favor (${breakdown.forWeight}) tied with votes against (${breakdown.againstWeight})`;
      } else {
        reason = `Proposal defeated: votes against (${breakdown.againstWeight}) exceed votes in favor (${breakdown.forWeight})`;
      }
    } else {
      reason = `Proposal succeeded: quorum met (${breakdown.totalWeight} >= ${requiredQuorumStr}) and votes in favor (${breakdown.forWeight}) exceed votes against (${breakdown.againstWeight})`;
    }

    const expiresAtDate = proposal.expiresAt instanceof Date
      ? proposal.expiresAt
      : new Date(proposal.expiresAt);
    const isExpired = now.getTime() >= expiresAtDate.getTime();

    return {
      proposalId: proposal.proposalId,
      contractId: proposal.contractId,
      quorumRequired: requiredQuorumStr,
      totalParticipatingWeight: breakdown.totalWeight,
      quorumMet,
      majorityMet,
      finalStatus,
      breakdown,
      reason,
      isExpired,
      evaluatedAt: now,
    };
  }

  /**
   * Verifies an individual proposal by proposalId and updates its status in the DB
   * if voting has expired or forceResolution is requested.
   */
  async verifyProposal(
    proposalId: string,
    options: VerifyProposalOptions = {},
  ): Promise<QuorumVerificationResult | null> {
    const now = options.now ?? new Date();

    const proposalRow = await this.db.governanceProposal.findUnique({
      where: { proposalId },
      include: { votes: true },
    });

    if (!proposalRow) {
      this.log.warn(`[GovernanceQuorumService] Proposal not found: ${proposalId}`);
      return null;
    }

    const result = this.evaluateProposal(
      proposalRow,
      proposalRow.votes,
      options.quorumThreshold,
      now,
    );

    // Only transition status if expired or forced
    if (result.isExpired || options.forceResolution) {
      await this.db.governanceProposal.update({
        where: { proposalId },
        data: {
          status: result.finalStatus,
          updatedAt: now,
        },
      });

      this.log.info(
        `[GovernanceQuorumService] Proposal ${proposalId} voting finalized with status ${result.finalStatus}. Reason: ${result.reason}`,
      );

      // Broadcast vote update to connected clients
      try {
        broadcastVoteUpdate(proposalId, {
          proposalId,
          forVotes: result.breakdown.forWeight,
          againstVotes: result.breakdown.againstWeight,
          abstainVotes: result.breakdown.abstainWeight,
          totalVotes: result.breakdown.totalWeight,
          thresholdMet: result.quorumMet,
        });

        broadcastTimelockStatus(proposalId, {
          proposalId,
          status: result.finalStatus === "SUCCEEDED" ? "Queued" : "Expired",
        });
      } catch (err) {
        this.log.warn(`[GovernanceQuorumService] WebSocket broadcast error:`, err);
      }
    }

    return result;
  }

  /**
   * Scans active governance proposals whose voting periods have expired,
   * evaluates their quorum thresholds, and marks them SUCCEEDED or DEFEATED.
   */
  async verifyExpiredProposals(now: Date = new Date()): Promise<QuorumVerificationResult[]> {
    const expiredProposals = await this.db.governanceProposal.findMany({
      where: {
        status: {
          in: ["Active", "ACTIVE", "Queued", "QUEUED", "Pending", "PENDING"],
        },
        expiresAt: {
          lte: now,
        },
      },
      include: {
        votes: true,
      },
      orderBy: {
        expiresAt: "asc",
      },
      take: 100,
    });

    const results: QuorumVerificationResult[] = [];

    for (const proposal of expiredProposals) {
      try {
        const evaluation = this.evaluateProposal(
          proposal,
          proposal.votes,
          undefined,
          now,
        );

        await this.db.governanceProposal.update({
          where: { proposalId: proposal.proposalId },
          data: {
            status: evaluation.finalStatus,
            updatedAt: now,
          },
        });

        results.push(evaluation);

        this.log.info(
          `[GovernanceQuorumService] Expired proposal ${proposal.proposalId} resolved as ${evaluation.finalStatus}. (V_total: ${evaluation.totalParticipatingWeight}, Q_required: ${evaluation.quorumRequired})`,
        );

        try {
          broadcastVoteUpdate(proposal.proposalId, {
            proposalId: proposal.proposalId,
            forVotes: evaluation.breakdown.forWeight,
            againstVotes: evaluation.breakdown.againstWeight,
            abstainVotes: evaluation.breakdown.abstainWeight,
            totalVotes: evaluation.breakdown.totalWeight,
            thresholdMet: evaluation.quorumMet,
          });
        } catch {
          // Non-critical broadcast failure
        }
      } catch (err) {
        this.log.error(
          `[GovernanceQuorumService] Failed to verify expired proposal ${proposal.proposalId}:`,
          err,
        );
      }
    }

    return results;
  }

  // ─── Background Service Lifecycle ──────────────────────────────────────────

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;

    this.log.info(
      `[GovernanceQuorumService] Starting quorum verification service (interval: ${this.pollIntervalMs}ms)`,
    );

    await this.tick();

    this.timer = setInterval(() => {
      this.tick().catch((err) => {
        this.log.error("[GovernanceQuorumService] Background tick error:", err);
      });
    }, this.pollIntervalMs);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.running = false;
    this.log.info("[GovernanceQuorumService] Stopped quorum verification service");
  }

  isRunning(): boolean {
    return this.running;
  }

  private async tick(): Promise<void> {
    if (this.isProcessing) return;
    this.isProcessing = true;
    try {
      await this.verifyExpiredProposals();
    } finally {
      this.isProcessing = false;
    }
  }
}

export const governanceQuorumVerificationService =
  new GovernanceQuorumVerificationService();
