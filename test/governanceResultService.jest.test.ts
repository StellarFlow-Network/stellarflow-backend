import { describe, it, expect, beforeEach, jest } from "@jest/globals";

const mockFindUnique = jest.fn<(args: unknown) => Promise<unknown>>();

jest.unstable_mockModule("../src/lib/prisma", () => ({
  __esModule: true,
  default: {
    governanceProposal: {
      findUnique: (args: unknown) => mockFindUnique(args),
    },
  },
}));

const {
  computeVoteTally,
  buildGovernanceResultSnapshot,
  serializeGovernanceResultSnapshot,
  sha256Hex,
  getProposalResultDetail,
} = await import("../src/services/governanceResultService.js");

const votes = [
  {
    accountId: "GZZZZ",
    choice: "For",
    weight: "10.5",
    votedAt: new Date("2026-09-01T10:00:00.000Z"),
    txHash: "tx-3",
  },
  {
    accountId: "GAAAA",
    choice: "For",
    weight: "0.25",
    votedAt: new Date("2026-09-01T09:00:00.000Z"),
    txHash: null,
  },
  {
    accountId: "GMMMM",
    choice: "Against",
    weight: "1.005",
    votedAt: new Date("2026-09-01T11:00:00.000Z"),
    txHash: "tx-1",
  },
];

const proposal = {
  proposalId: "42",
  contractId: "CGOVERNANCE",
  title: "Raise staking rewards",
  actionType: "UpdateConfig",
  status: "Executed",
  expiresAt: new Date("2026-09-05T00:00:00.000Z"),
  queuedAt: new Date("2026-09-04T00:00:00.000Z"),
  executedAt: new Date("2026-09-06T00:00:00.000Z"),
  cancelledAt: null,
  transactionHash: "deadbeef",
};

describe("computeVoteTally", () => {
  it("sums weights per choice with exact decimal precision", () => {
    const tally = computeVoteTally(votes);

    expect(tally.totalVoters).toBe(3);
    expect(tally.totalWeight).toBe("11.755");
    expect(tally.byChoice).toEqual({
      Against: { votes: 1, weight: "1.005" },
      For: { votes: 2, weight: "10.75" },
    });
  });

  it("exposes choices in sorted key order for stable serialization", () => {
    const tally = computeVoteTally([
      { accountId: "G1", choice: "For", weight: "1", votedAt: new Date() },
      { accountId: "G2", choice: "Abstain", weight: "1", votedAt: new Date() },
      { accountId: "G3", choice: "Against", weight: "1", votedAt: new Date() },
    ]);

    expect(Object.keys(tally.byChoice)).toEqual(["Abstain", "Against", "For"]);
  });

  it("trims trailing zeros without losing precision", () => {
    const tally = computeVoteTally([
      { accountId: "G1", choice: "For", weight: "2.500", votedAt: new Date() },
      { accountId: "G2", choice: "For", weight: "3", votedAt: new Date() },
    ]);

    expect(tally.totalWeight).toBe("5.5");
    expect(tally.byChoice.For?.weight).toBe("5.5");
  });

  it("returns an empty tally when nobody voted", () => {
    expect(computeVoteTally([])).toEqual({
      totalVoters: 0,
      totalWeight: "0",
      byChoice: {},
    });
  });

  it("sums weights expressed in exponential notation", () => {
    const tally = computeVoteTally([
      { accountId: "G1", choice: "For", weight: "1.5e-7", votedAt: new Date() },
      { accountId: "G2", choice: "For", weight: "2.5e+2", votedAt: new Date() },
    ]);

    expect(tally.totalWeight).toBe("250.00000015");
    expect(tally.byChoice.For?.weight).toBe("250.00000015");
  });

  it("rejects malformed weights", () => {
    expect(() =>
      computeVoteTally([
        {
          accountId: "G1",
          choice: "For",
          weight: "not-a-number",
          votedAt: new Date(),
        },
      ]),
    ).toThrow('Invalid vote weight: "not-a-number"');
  });
});

describe("buildGovernanceResultSnapshot", () => {
  it("produces byte-identical output for identical inputs", () => {
    const generatedAt = new Date("2026-09-10T12:00:00.000Z");
    const first = serializeGovernanceResultSnapshot(
      buildGovernanceResultSnapshot(proposal, votes, generatedAt),
    );
    const second = serializeGovernanceResultSnapshot(
      buildGovernanceResultSnapshot(proposal, votes, generatedAt),
    );

    expect(first.equals(second)).toBe(true);
    expect(sha256Hex(first)).toBe(sha256Hex(second));
  });

  it("sorts voters by account so the voter list is deterministic", () => {
    const snapshot = buildGovernanceResultSnapshot(
      proposal,
      votes,
      new Date("2026-09-10T12:00:00.000Z"),
    );

    expect(snapshot.voters.map((voter) => voter.accountId)).toEqual([
      "GAAAA",
      "GMMMM",
      "GZZZZ",
    ]);
    expect(snapshot.voters[0]).toEqual({
      accountId: "GAAAA",
      choice: "For",
      weight: "0.25",
      votedAt: "2026-09-01T09:00:00.000Z",
      txHash: null,
    });
  });

  it("embeds the proposal, tally and schema version", () => {
    const snapshot = buildGovernanceResultSnapshot(
      proposal,
      votes,
      new Date("2026-09-10T12:00:00.000Z"),
    );

    expect(snapshot.schema).toBe(
      "stellarflow.governance.proposal_result_snapshot",
    );
    expect(snapshot.version).toBe(1);
    expect(snapshot.generatedAt).toBe("2026-09-10T12:00:00.000Z");
    expect(snapshot.proposal).toMatchObject({
      proposalId: "42",
      status: "Executed",
      executedAt: "2026-09-06T00:00:00.000Z",
      cancelledAt: null,
    });
    expect(snapshot.tally.totalWeight).toBe("11.755");
    expect(sha256Hex(serializeGovernanceResultSnapshot(snapshot))).toMatch(
      /^[0-9a-f]{64}$/,
    );
  });
});

describe("getProposalResultDetail", () => {
  beforeEach(() => {
    mockFindUnique.mockReset();
  });

  it("returns null when the proposal does not exist", async () => {
    mockFindUnique.mockResolvedValue(null);

    await expect(getProposalResultDetail("missing")).resolves.toBeNull();
    expect(mockFindUnique).toHaveBeenCalledWith({
      where: { proposalId: "missing" },
      include: {
        votes: { orderBy: [{ accountId: "asc" }, { votedAt: "asc" }] },
      },
    });
  });

  it("returns tally and participation without an export before the worker ran", async () => {
    mockFindUnique.mockResolvedValue({
      ...proposal,
      createdAt: new Date("2026-08-01T00:00:00.000Z"),
      updatedAt: new Date("2026-09-06T00:00:00.000Z"),
      resultExportCid: null,
      resultExportContentHash: null,
      resultExportedAt: null,
      votes,
    });

    const detail = await getProposalResultDetail("42");

    expect(detail?.tally.totalVoters).toBe(3);
    expect(detail?.voterCount).toBe(3);
    expect(detail?.proposal.status).toBe("Executed");
    expect(detail?.resultExport).toBeNull();
  });

  it("returns the stored IPFS CID once the snapshot has been exported", async () => {
    mockFindUnique.mockResolvedValue({
      ...proposal,
      createdAt: new Date("2026-08-01T00:00:00.000Z"),
      updatedAt: new Date("2026-09-06T00:00:00.000Z"),
      resultExportCid: "bafybeigdyr",
      resultExportContentHash: "a".repeat(64),
      resultExportedAt: new Date("2026-09-07T08:30:00.000Z"),
      votes,
    });

    const detail = await getProposalResultDetail("42");

    expect(detail?.resultExport).toEqual({
      cid: "bafybeigdyr",
      contentHash: "a".repeat(64),
      exportedAt: "2026-09-07T08:30:00.000Z",
    });
  });
});
