/**
 * Multi-Collateral Vault Systemic Risk Score Engine (Issue #978)
 *
 * Protocol-wide solvency is measured as the system health index
 *
 *     S_risk = SUM(V_collateral) / SUM(D_debt)
 *
 * taken over every *active* vault. The engine turns that index into a protocol
 * danger level (`NORMAL`, `ELEVATED`, `CRITICAL`) and, when the index drops
 * below a configurable trigger threshold (1.25 by default), raises an
 * automated risk-parameter adjustment proposal.
 *
 * The module is intentionally dependency-free: every side effect (reading the
 * active vaults, submitting a proposal, publishing metrics) is injected, which
 * keeps the scoring rules deterministic and unit-testable in isolation.
 */

export type SystemicRiskLevel = "NORMAL" | "ELEVATED" | "CRITICAL";

export interface SystemicRiskAssetPosition {
  /** Asset code or contract address, used only for diagnostics. */
  asset: string;
  /** Units of the asset held or owed by the vault. */
  amount: number;
  /** Oracle value of one unit of the asset, expressed in USD. */
  priceUsd: number;
}

export interface SystemicRiskVault {
  vaultId: string;
  /** Optional owner account, surfaced for diagnostics only. */
  owner?: string;
  /** Vaults explicitly flagged `false` are excluded from the index. */
  active?: boolean;
  collateral: SystemicRiskAssetPosition[];
  debt: SystemicRiskAssetPosition[];
}

export interface SystemicRiskSource {
  listActiveVaults(): Promise<SystemicRiskVault[]>;
}

export interface RiskParameterAdjustment {
  parameter: string;
  currentValue: number;
  proposedValue: number;
}

export interface RiskParameterProposal {
  proposalId: string;
  title: string;
  reason: string;
  dangerLevel: SystemicRiskLevel;
  systemicRiskScore: number;
  triggerThreshold: number;
  adjustments: RiskParameterAdjustment[];
  createdAt: string;
}

export interface RiskParameterProposalSink {
  submit(proposal: RiskParameterProposal): Promise<void>;
}

export interface SystemicRiskSnapshot {
  /** null when the protocol carries no debt, so the index is unbounded. */
  systemicRiskScore: number | null;
  dangerLevel: SystemicRiskLevel;
  totalCollateralValueUsd: number;
  totalDebtValueUsd: number;
  activeVaultCount: number;
  excludedVaultCount: number;
  proposalTriggered: boolean;
  proposal: RiskParameterProposal | null;
  proposalError: string | null;
  evaluatedAt: string;
}

export interface SystemicRiskMetricsSink {
  recordSnapshot(snapshot: SystemicRiskSnapshot): void;
  recordProposal(proposal: RiskParameterProposal): void;
  recordProposalFailure(error: unknown): void;
}

export interface RiskParameterPolicyEntry {
  parameter: string;
  currentValue: number;
  /** `proposedValue = currentValue * proposedMultiplier`. */
  proposedMultiplier: number;
}

export interface SystemicRiskTotals {
  totalCollateralValueUsd: number;
  totalDebtValueUsd: number;
  activeVaultCount: number;
  excludedVaultCount: number;
}

export interface SystemicRiskOptions {
  /** S_risk below this value triggers a parameter adjustment proposal. */
  triggerThreshold?: number;
  /** S_risk below this value (but at or above the trigger) is ELEVATED. */
  elevatedThreshold?: number;
  /** Minimum delay between two proposals raised from the same breach. */
  proposalCooldownMs?: number;
  /** Parameter adjustments attached to a triggered proposal. */
  parameterPolicy?: RiskParameterPolicyEntry[];
  now?: () => number;
  proposalIdFactory?: (nowMs: number, score: number) => string;
}

export const DEFAULT_SYSTEMIC_RISK_TRIGGER_THRESHOLD = 1.25;
export const DEFAULT_SYSTEMIC_RISK_ELEVATED_THRESHOLD = 1.5;
export const DEFAULT_RISK_PROPOSAL_COOLDOWN_MS = 15 * 60 * 1000;

/**
 * Conservative defaults used when a breach is detected: reduce how much can be
 * borrowed against collateral and raise the liquidation buffer. Both entries
 * are plain multipliers so operators can tune (or replace) the policy.
 */
export const DEFAULT_RISK_PARAMETER_POLICY: RiskParameterPolicyEntry[] = [
  {
    parameter: "maxLoanToValueRatio",
    currentValue: 0.8,
    proposedMultiplier: 0.9,
  },
  {
    parameter: "liquidationThreshold",
    currentValue: 1.1,
    proposedMultiplier: 1.1,
  },
];

function assertPositiveFinite(value: number, field: string): void {
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${field} must be a positive finite number`);
  }
}

function assertFiniteNonNegative(value: number, field: string): void {
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`${field} must be a finite non-negative number`);
  }
}

function roundTo(value: number, decimals: number): number {
  return Number(value.toFixed(decimals));
}

/**
 * Pure systemic risk engine. Construct once and call `evaluate()` on every
 * monitoring tick (or on demand from the API).
 */
export class SystemicRiskService {
  private readonly source: SystemicRiskSource;
  private readonly proposalSink: RiskParameterProposalSink | null;
  private readonly metrics: SystemicRiskMetricsSink | null;
  private readonly triggerThreshold: number;
  private readonly elevatedThreshold: number;
  private readonly proposalCooldownMs: number;
  private readonly parameterPolicy: RiskParameterPolicyEntry[];
  private readonly now: () => number;
  private readonly proposalIdFactory: (
    nowMs: number,
    score: number,
  ) => string;

  /** True while the protocol is inside a CRITICAL breach episode. */
  private insideCriticalBreach = false;
  private lastProposalAtMs: number | null = null;
  private lastSnapshot: SystemicRiskSnapshot | null = null;

  constructor(
    source: SystemicRiskSource,
    proposalSink: RiskParameterProposalSink | null = null,
    options: SystemicRiskOptions = {},
    metrics: SystemicRiskMetricsSink | null = null,
  ) {
    this.source = source;
    this.proposalSink = proposalSink;
    this.metrics = metrics;

    this.triggerThreshold =
      options.triggerThreshold ?? DEFAULT_SYSTEMIC_RISK_TRIGGER_THRESHOLD;
    this.elevatedThreshold =
      options.elevatedThreshold ?? DEFAULT_SYSTEMIC_RISK_ELEVATED_THRESHOLD;
    this.proposalCooldownMs =
      options.proposalCooldownMs ?? DEFAULT_RISK_PROPOSAL_COOLDOWN_MS;
    this.parameterPolicy = options.parameterPolicy ?? DEFAULT_RISK_PARAMETER_POLICY;
    this.now = options.now ?? Date.now;
    this.proposalIdFactory =
      options.proposalIdFactory ??
      ((nowMs: number, score: number) =>
        `systemic-risk-${nowMs}-${score.toFixed(4)}`);

    assertPositiveFinite(this.triggerThreshold, "triggerThreshold");
    assertPositiveFinite(this.elevatedThreshold, "elevatedThreshold");
    if (this.elevatedThreshold <= this.triggerThreshold) {
      throw new Error(
        "elevatedThreshold must be greater than triggerThreshold",
      );
    }
    assertFiniteNonNegative(this.proposalCooldownMs, "proposalCooldownMs");
    for (const entry of this.parameterPolicy) {
      if (!entry.parameter) {
        throw new Error("parameterPolicy entries require a parameter name");
      }
      assertPositiveFinite(
        entry.currentValue,
        `parameterPolicy.${entry.parameter}.currentValue`,
      );
      assertPositiveFinite(
        entry.proposedMultiplier,
        `parameterPolicy.${entry.parameter}.proposedMultiplier`,
      );
    }
  }

  getLastSnapshot(): SystemicRiskSnapshot | null {
    return this.lastSnapshot;
  }

  /**
   * S_risk = SUM(V_collateral) / SUM(D_debt). A protocol with no outstanding
   * debt has an unbounded index, so `null` is returned instead of Infinity.
   */
  calculateSystemicRiskScore(
    totalCollateralValueUsd: number,
    totalDebtValueUsd: number,
  ): number | null {
    assertFiniteNonNegative(totalCollateralValueUsd, "totalCollateralValueUsd");
    assertFiniteNonNegative(totalDebtValueUsd, "totalDebtValueUsd");
    if (totalDebtValueUsd === 0) return null;
    return totalCollateralValueUsd / totalDebtValueUsd;
  }

  classifyDangerLevel(score: number | null): SystemicRiskLevel {
    if (score === null) return "NORMAL";
    if (score < this.triggerThreshold) return "CRITICAL";
    if (score < this.elevatedThreshold) return "ELEVATED";
    return "NORMAL";
  }

  /** Validates and values every vault, skipping those marked inactive. */
  aggregateVaults(vaults: SystemicRiskVault[]): SystemicRiskTotals {
    let totalCollateralValueUsd = 0;
    let totalDebtValueUsd = 0;
    let activeVaultCount = 0;
    let excludedVaultCount = 0;

    for (const vault of vaults) {
      if (!vault.vaultId) {
        throw new Error("Every vault requires a vaultId");
      }
      if (vault.active === false) {
        excludedVaultCount += 1;
        continue;
      }
      activeVaultCount += 1;
      totalCollateralValueUsd += this.valuePositions(
        vault.vaultId,
        "collateral",
        vault.collateral,
      );
      totalDebtValueUsd += this.valuePositions(
        vault.vaultId,
        "debt",
        vault.debt,
      );
    }

    return {
      totalCollateralValueUsd,
      totalDebtValueUsd,
      activeVaultCount,
      excludedVaultCount,
    };
  }

  /**
   * Evaluates the protocol, publishes metrics, and raises a parameter
   * adjustment proposal when S_risk falls below the trigger threshold.
   */
  async evaluate(): Promise<SystemicRiskSnapshot> {
    const vaults = await this.source.listActiveVaults();
    const totals = this.aggregateVaults(vaults);
    const score = this.calculateSystemicRiskScore(
      totals.totalCollateralValueUsd,
      totals.totalDebtValueUsd,
    );
    const dangerLevel = this.classifyDangerLevel(score);
    const nowMs = this.now();

    let proposal: RiskParameterProposal | null = null;
    let proposalTriggered = false;
    let proposalError: string | null = null;

    if (dangerLevel === "CRITICAL" && score !== null) {
      if (this.proposalSink && this.shouldTriggerProposal(nowMs)) {
        const candidate = this.buildProposal(score, nowMs);
        try {
          await this.proposalSink.submit(candidate);
          proposal = candidate;
          proposalTriggered = true;
          this.lastProposalAtMs = nowMs;
          this.metrics?.recordProposal(candidate);
        } catch (error) {
          proposalError =
            error instanceof Error ? error.message : String(error);
          this.metrics?.recordProposalFailure(error);
        }
      }
      this.insideCriticalBreach = true;
    } else {
      // Recovering resets the breach so the next crossing triggers immediately.
      this.insideCriticalBreach = false;
      this.lastProposalAtMs = null;
    }

    const snapshot: SystemicRiskSnapshot = {
      systemicRiskScore: score,
      dangerLevel,
      totalCollateralValueUsd: totals.totalCollateralValueUsd,
      totalDebtValueUsd: totals.totalDebtValueUsd,
      activeVaultCount: totals.activeVaultCount,
      excludedVaultCount: totals.excludedVaultCount,
      proposalTriggered,
      proposal,
      proposalError,
      evaluatedAt: new Date(nowMs).toISOString(),
    };

    this.lastSnapshot = snapshot;
    this.metrics?.recordSnapshot(snapshot);
    return snapshot;
  }

  private valuePositions(
    vaultId: string,
    side: "collateral" | "debt",
    positions: SystemicRiskAssetPosition[],
  ): number {
    let total = 0;
    for (const position of positions) {
      const label = `${vaultId}.${side}.${position.asset || "unknown"}`;
      assertFiniteNonNegative(position.amount, `${label}.amount`);
      if (position.amount === 0) continue;
      assertPositiveFinite(position.priceUsd, `${label}.priceUsd`);
      total += position.amount * position.priceUsd;
      assertFiniteNonNegative(total, `${label}.value`);
    }
    return total;
  }

  private shouldTriggerProposal(nowMs: number): boolean {
    if (!this.insideCriticalBreach) return true;
    if (this.lastProposalAtMs === null) return true;
    return nowMs - this.lastProposalAtMs >= this.proposalCooldownMs;
  }

  private buildProposal(
    score: number,
    nowMs: number,
  ): RiskParameterProposal {
    return {
      proposalId: this.proposalIdFactory(nowMs, score),
      title: "Systemic risk parameter adjustment",
      reason:
        `Protocol systemic risk score ${score.toFixed(4)} is below the ` +
        `${this.triggerThreshold} trigger threshold`,
      dangerLevel: "CRITICAL",
      systemicRiskScore: score,
      triggerThreshold: this.triggerThreshold,
      adjustments: this.parameterPolicy.map((entry) => ({
        parameter: entry.parameter,
        currentValue: entry.currentValue,
        proposedValue: roundTo(
          entry.currentValue * entry.proposedMultiplier,
          6,
        ),
      })),
      createdAt: new Date(nowMs).toISOString(),
    };
  }
}

/** In-memory proposal sink, useful for tests and local development. */
export class RecordingRiskProposalSink implements RiskParameterProposalSink {
  readonly proposals: RiskParameterProposal[] = [];

  async submit(proposal: RiskParameterProposal): Promise<void> {
    this.proposals.push(proposal);
  }
}
