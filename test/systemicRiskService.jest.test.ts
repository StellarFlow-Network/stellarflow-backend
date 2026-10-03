import {
  SystemicRiskService,
  RecordingRiskProposalSink,
  DEFAULT_SYSTEMIC_RISK_TRIGGER_THRESHOLD,
  DEFAULT_RISK_PARAMETER_POLICY,
  type RiskParameterProposal,
  type SystemicRiskLevel,
  type SystemicRiskMetricsSink,
  type SystemicRiskSnapshot,
  type SystemicRiskSource,
  type SystemicRiskVault,
} from "../src/services/systemicRiskService";

function sourceOf(vaults: SystemicRiskVault[]): SystemicRiskSource {
  return { listActiveVaults: async () => vaults };
}

function vaultWithRatio(ratio: number, id = "v1"): SystemicRiskVault {
  return {
    vaultId: id,
    collateral: [{ asset: "XLM", amount: ratio * 100, priceUsd: 1 }],
    debt: [{ asset: "USDC", amount: 100, priceUsd: 1 }],
  };
}

describe("SystemicRiskService", () => {
  it("computes S_risk as SUM(collateral) / SUM(debt) across active vaults", async () => {
    const service = new SystemicRiskService(
      sourceOf([
        {
          vaultId: "v1",
          collateral: [{ asset: "XLM", amount: 100, priceUsd: 1 }],
          debt: [{ asset: "USDC", amount: 100, priceUsd: 1 }],
        },
        {
          vaultId: "v2",
          collateral: [{ asset: "BTC", amount: 1, priceUsd: 350 }],
          debt: [{ asset: "USDC", amount: 200, priceUsd: 1 }],
        },
      ]),
    );

    const snapshot = await service.evaluate();

    expect(snapshot.totalCollateralValueUsd).toBe(450);
    expect(snapshot.totalDebtValueUsd).toBe(300);
    expect(snapshot.systemicRiskScore).toBeCloseTo(1.5, 10);
    expect(snapshot.activeVaultCount).toBe(2);
    expect(snapshot.dangerLevel).toBe("NORMAL");
  });

  it("maps S_risk onto the NORMAL / ELEVATED / CRITICAL danger levels", () => {
    const service = new SystemicRiskService(sourceOf([]));

    expect(DEFAULT_SYSTEMIC_RISK_TRIGGER_THRESHOLD).toBe(1.25);
    expect(service.classifyDangerLevel(null)).toBe("NORMAL");
    expect(service.classifyDangerLevel(0)).toBe("CRITICAL");
    expect(service.classifyDangerLevel(1.2499)).toBe("CRITICAL");
    // The trigger is strictly below 1.25, so 1.25 itself is only ELEVATED.
    expect(service.classifyDangerLevel(1.25)).toBe("ELEVATED");
    expect(service.classifyDangerLevel(1.4999)).toBe("ELEVATED");
    expect(service.classifyDangerLevel(1.5)).toBe("NORMAL");
  });

  it("treats a debt-free protocol as NORMAL without raising a proposal", async () => {
    const sink = new RecordingRiskProposalSink();
    const service = new SystemicRiskService(
      sourceOf([
        {
          vaultId: "v1",
          collateral: [{ asset: "XLM", amount: 10, priceUsd: 2 }],
          debt: [],
        },
      ]),
      sink,
    );

    const snapshot = await service.evaluate();

    expect(snapshot.systemicRiskScore).toBeNull();
    expect(snapshot.dangerLevel).toBe("NORMAL");
    expect(sink.proposals).toHaveLength(0);
  });

  it("raises a parameter adjustment proposal when S_risk falls below 1.25", async () => {
    const sink = new RecordingRiskProposalSink();
    const service = new SystemicRiskService(sourceOf([vaultWithRatio(1.2)]), sink);

    const snapshot = await service.evaluate();

    expect(snapshot.dangerLevel).toBe("CRITICAL");
    expect(snapshot.proposalTriggered).toBe(true);
    expect(sink.proposals).toHaveLength(1);
    expect(snapshot.proposal).toEqual(
      expect.objectContaining({
        dangerLevel: "CRITICAL",
        triggerThreshold: 1.25,
      }),
    );
    expect(snapshot.proposal?.adjustments).toEqual([
      { parameter: "maxLoanToValueRatio", currentValue: 0.8, proposedValue: 0.72 },
      { parameter: "liquidationThreshold", currentValue: 1.1, proposedValue: 1.21 },
    ]);
  });

  it("does not raise a proposal at or above the trigger threshold", async () => {
    const sink = new RecordingRiskProposalSink();
    const service = new SystemicRiskService(sourceOf([vaultWithRatio(1.25)]), sink);

    const snapshot = await service.evaluate();

    expect(snapshot.dangerLevel).toBe("ELEVATED");
    expect(snapshot.proposalTriggered).toBe(false);
    expect(sink.proposals).toHaveLength(0);
  });

  it("de-duplicates proposals while the breach persists and re-arms on recovery", async () => {
    let now = 1_000_000;
    let ratio = 1.1;
    const sink = new RecordingRiskProposalSink();
    const service = new SystemicRiskService(
      { listActiveVaults: async () => [vaultWithRatio(ratio)] },
      sink,
      { now: () => now },
    );

    await service.evaluate();
    expect(sink.proposals).toHaveLength(1);

    now += 1_000;
    await service.evaluate();
    expect(sink.proposals).toHaveLength(1);

    now += 15 * 60 * 1000;
    await service.evaluate();
    expect(sink.proposals).toHaveLength(2);

    ratio = 2; // recover
    await service.evaluate();
    ratio = 1.1; // fresh breach
    const recovered = await service.evaluate();
    expect(sink.proposals).toHaveLength(3);
    expect(recovered.proposalTriggered).toBe(true);
  });

  it("excludes inactive vaults and counts them", async () => {
    const service = new SystemicRiskService(
      sourceOf([
        {
          vaultId: "inactive",
          active: false,
          collateral: [{ asset: "XLM", amount: 1_000, priceUsd: 1 }],
          debt: [{ asset: "USDC", amount: 1, priceUsd: 1 }],
        },
        vaultWithRatio(3, "active"),
      ]),
    );

    const snapshot = await service.evaluate();

    expect(snapshot.activeVaultCount).toBe(1);
    expect(snapshot.excludedVaultCount).toBe(1);
    expect(snapshot.totalCollateralValueUsd).toBe(300);
    expect(snapshot.totalDebtValueUsd).toBe(100);
  });

  it("rejects malformed vault positions and invalid thresholds", () => {
    const service = new SystemicRiskService(sourceOf([]));

    expect(() =>
      service.aggregateVaults([
        {
          vaultId: "v1",
          collateral: [{ asset: "XLM", amount: -1, priceUsd: 1 }],
          debt: [],
        },
      ]),
    ).toThrow(/amount/);

    expect(() =>
      service.aggregateVaults([
        {
          vaultId: "v1",
          collateral: [{ asset: "XLM", amount: 1, priceUsd: 0 }],
          debt: [],
        },
      ]),
    ).toThrow(/priceUsd/);

    expect(
      () =>
        new SystemicRiskService(sourceOf([]), null, {
          triggerThreshold: 2,
          elevatedThreshold: 1.5,
        }),
    ).toThrow(/elevatedThreshold/);
  });

  it("publishes snapshots and triggered proposals to the metrics sink", async () => {
    const snapshots: SystemicRiskSnapshot[] = [];
    const proposals: RiskParameterProposal[] = [];
    const failures: unknown[] = [];
    const metrics: SystemicRiskMetricsSink = {
      recordSnapshot: (snapshot) => void snapshots.push(snapshot),
      recordProposal: (proposal) => void proposals.push(proposal),
      recordProposalFailure: (error) => void failures.push(error),
    };
    const sink = new RecordingRiskProposalSink();
    const service = new SystemicRiskService(
      sourceOf([vaultWithRatio(1)]),
      sink,
      {},
      metrics,
    );

    const snapshot = await service.evaluate();

    expect(snapshots).toEqual([snapshot]);
    expect(proposals).toHaveLength(1);
    expect(failures).toHaveLength(0);
    expect(DEFAULT_RISK_PARAMETER_POLICY).toHaveLength(2);
  });

  it("captures proposal submission failures instead of throwing", async () => {
    const failures: unknown[] = [];
    const service = new SystemicRiskService(
      sourceOf([vaultWithRatio(1)]),
      {
        submit: async () => {
          throw new Error("governance submission unavailable");
        },
      },
      {},
      {
        recordSnapshot: () => undefined,
        recordProposal: () => undefined,
        recordProposalFailure: (error) => void failures.push(error),
      },
    );

    const snapshot = await service.evaluate();

    expect(snapshot.proposalTriggered).toBe(false);
    expect(snapshot.proposalError).toBe("governance submission unavailable");
    expect(failures).toHaveLength(1);
    const level: SystemicRiskLevel = snapshot.dangerLevel;
    expect(level).toBe("CRITICAL");
  });
});
