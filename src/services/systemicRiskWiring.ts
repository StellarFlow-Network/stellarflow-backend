/**
 * Observability and side-effect wiring for the systemic risk engine
 * (Issue #978).
 *
 * Metrics are registered on the shared Prometheus registry used by the
 * `/metrics` endpoint, so the protocol danger level is scrapeable as soon as
 * the engine is evaluated.
 *
 * On-chain governance submission is not implemented in this backend (the
 * timelock service only indexes and executes proposals created externally), so
 * the default proposal sink records the proposal and increments its counter.
 * A deployment that can submit proposals implements `RiskParameterProposalSink`
 * and passes it to `createSystemicRiskService`.
 */
import { Counter, Gauge } from "prom-client";
import { register } from "../middleware/metrics";
import { logger } from "../utils/logger";
import { VaultService } from "./vaultService";
import {
  SystemicRiskService,
  type RiskParameterProposal,
  type RiskParameterProposalSink,
  type SystemicRiskLevel,
  type SystemicRiskMetricsSink,
  type SystemicRiskSnapshot,
} from "./systemicRiskService";
import {
  systemicRiskAccountIdsFromEnv,
  VaultServiceSystemicRiskSource,
} from "./vaultSystemicRiskSource";

const environment = process.env.NODE_ENV || "development";

const SYSTEMIC_RISK_LEVELS: SystemicRiskLevel[] = [
  "NORMAL",
  "ELEVATED",
  "CRITICAL",
];

export const systemicRiskScoreGauge = new Gauge({
  name: "protocol_systemic_risk_score",
  help: "Protocol-wide collateral-to-debt health index (S_risk); 0 when debt-free (see protocol_systemic_risk_debt_free)",
  labelNames: ["environment"] as const,
});
register.registerMetric(systemicRiskScoreGauge);

export const systemicRiskDebtFreeGauge = new Gauge({
  name: "protocol_systemic_risk_debt_free",
  help: "1 when the protocol has no outstanding debt, so S_risk is unbounded; 0 otherwise",
  labelNames: ["environment"] as const,
});
register.registerMetric(systemicRiskDebtFreeGauge);

export const systemicRiskDangerLevelGauge = new Gauge({
  name: "protocol_systemic_risk_danger_level",
  help: "1 for the current protocol danger level, 0 for the others",
  labelNames: ["environment", "level"] as const,
});
register.registerMetric(systemicRiskDangerLevelGauge);

export const systemicRiskAssetsGauge = new Gauge({
  name: "protocol_systemic_risk_assets_usd",
  help: "USD value of collateral and debt summed across active vaults",
  labelNames: ["environment", "side"] as const,
});
register.registerMetric(systemicRiskAssetsGauge);

export const systemicRiskActiveVaultsGauge = new Gauge({
  name: "protocol_systemic_risk_active_vaults",
  help: "Number of active vaults included in the systemic risk index",
  labelNames: ["environment"] as const,
});
register.registerMetric(systemicRiskActiveVaultsGauge);

export const systemicRiskProposalsTotal = new Counter({
  name: "protocol_systemic_risk_proposals_total",
  help: "Total automated risk-parameter adjustment proposals raised by the engine",
  labelNames: ["environment"] as const,
});
register.registerMetric(systemicRiskProposalsTotal);

export const systemicRiskProposalFailuresTotal = new Counter({
  name: "protocol_systemic_risk_proposal_failures_total",
  help: "Total risk-parameter adjustment proposals that failed to submit",
  labelNames: ["environment"] as const,
});
register.registerMetric(systemicRiskProposalFailuresTotal);

export const systemicRiskMetricsSink: SystemicRiskMetricsSink = {
  recordSnapshot(snapshot: SystemicRiskSnapshot): void {
    const debtFree = snapshot.systemicRiskScore === null;
    systemicRiskScoreGauge.set(
      { environment },
      snapshot.systemicRiskScore ?? 0,
    );
    systemicRiskDebtFreeGauge.set({ environment }, debtFree ? 1 : 0);
    for (const level of SYSTEMIC_RISK_LEVELS) {
      systemicRiskDangerLevelGauge.set(
        { environment, level },
        snapshot.dangerLevel === level ? 1 : 0,
      );
    }
    systemicRiskAssetsGauge.set(
      { environment, side: "collateral" },
      snapshot.totalCollateralValueUsd,
    );
    systemicRiskAssetsGauge.set(
      { environment, side: "debt" },
      snapshot.totalDebtValueUsd,
    );
    systemicRiskActiveVaultsGauge.set(
      { environment },
      snapshot.activeVaultCount,
    );
  },

  recordProposal(_proposal: RiskParameterProposal): void {
    systemicRiskProposalsTotal.inc({ environment });
  },

  recordProposalFailure(): void {
    systemicRiskProposalFailuresTotal.inc({ environment });
  },
};

/**
 * Default sink. Logs the proposal and relies on the metrics sink for the
 * counter; replace with a governance/on-chain adapter when available.
 */
export const governanceRiskProposalSink: RiskParameterProposalSink = {
  async submit(proposal: RiskParameterProposal): Promise<void> {
    logger.warn(
      `[SystemicRisk] Raising risk-parameter proposal ${proposal.proposalId}: ` +
        `${proposal.reason}. Adjustments: ${proposal.adjustments
          .map(
            (adjustment) =>
              `${adjustment.parameter} ${adjustment.currentValue} -> ${adjustment.proposedValue}`,
          )
          .join(", ")}`,
    );
  },
};

export const DEFAULT_SYSTEMIC_RISK_EVALUATION_INTERVAL_MS = 60_000;

/**
 * Drives the engine on a fixed interval so breaches are detected and proposals
 * raised without waiting for an API call. Mirrors the start/stop lifecycle used
 * by the other background services.
 */
export class SystemicRiskMonitor {
  private readonly service: SystemicRiskService;
  private readonly intervalMs: number;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    service: SystemicRiskService,
    intervalMs = Number(
      process.env.SYSTEMIC_RISK_EVALUATION_INTERVAL_MS ??
        DEFAULT_SYSTEMIC_RISK_EVALUATION_INTERVAL_MS,
    ),
  ) {
    this.service = service;
    this.intervalMs =
      Number.isFinite(intervalMs) && intervalMs > 0
        ? intervalMs
        : DEFAULT_SYSTEMIC_RISK_EVALUATION_INTERVAL_MS;
  }

  start(): void {
    if (this.timer) return;
    void this.tick();
    this.timer = setInterval(() => void this.tick(), this.intervalMs);
    this.timer.unref?.();
    logger.info(
      `[SystemicRisk] Monitor started with ${this.intervalMs}ms interval`,
    );
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private async tick(): Promise<void> {
    try {
      await this.service.evaluate();
    } catch (error) {
      logger.error("[SystemicRisk] Evaluation failed:", error);
    }
  }
}

export function createSystemicRiskService(
  accountIds: string[] = systemicRiskAccountIdsFromEnv(),
): SystemicRiskService {
  const source = new VaultServiceSystemicRiskSource(
    VaultService.getInstance(),
    accountIds,
  );
  return new SystemicRiskService(
    source,
    governanceRiskProposalSink,
    {},
    systemicRiskMetricsSink,
  );
}

export const systemicRiskService = createSystemicRiskService();

export const systemicRiskMonitor = new SystemicRiskMonitor(systemicRiskService);
