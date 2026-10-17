import { describe, it, expect, beforeEach, afterEach, jest } from "@jest/globals";

const mockFindMany = jest.fn<(args: unknown) => Promise<unknown[]>>();
const mockFindUnique = jest.fn<(args: unknown) => Promise<unknown>>();
const mockUpdate = jest.fn<(args: unknown) => Promise<unknown>>();
const mockBroadcastVoteUpdate = jest.fn();
const mockBroadcastTimelockStatus = jest.fn();

jest.unstable_mockModule("../src/lib/prisma", () => ({
  __esModule: true,
  default: {
    governanceProposal: {
      findMany: (args: unknown) => mockFindMany(args),
      findUnique: (args: unknown) => mockFindUnique(args),
      update: (args: unknown) => mockUpdate(args),
    },
  },
}));

jest.unstable_mockModule("../src/websockets/governanceWebSocket.service", () => ({
  __esModule: true,
  broadcastVoteUpdate: mockBroadcastVoteUpdate,
  broadcastTimelockStatus: mockBroadcastTimelockStatus,
}));

const {
  GovernanceQuorumVerificationService,
  calculateVoteWeights,
  extractRequiredQuorum,
  toScaledWeight,
  normalizeVoteChoice,
} = await import("../src/services/governanceQuorumVerificationService.js");

describe("GovernanceQuorumVerificationService", () => {
  describe("normalizeVoteChoice", () => {
    it("normalizes affirmative choices to 'For'", () => {
      expect(normalizeVoteChoice("for")).toBe("For");
      expect(normalizeVoteChoice("FOR")).toBe("For");
      expect(normalizeVoteChoice("For ")).toBe("For");
      expect(normalizeVoteChoice("yes")).toBe("For");
      expect(normalizeVoteChoice("1")).toBe("For");
      expect(normalizeVoteChoice("approve")).toBe("For");
    });

    it("normalizes negative choices to 'Against'", () => {
      expect(normalizeVoteChoice("against")).toBe("Against");
      expect(normalizeVoteChoice("AGAINST")).toBe("Against");
      expect(normalizeVoteChoice("Against ")).toBe("Against");
      expect(normalizeVoteChoice("no")).toBe("Against");
      expect(normalizeVoteChoice("0")).toBe("Against");
      expect(normalizeVoteChoice("reject")).toBe("Against");
    });

    it("normalizes neutral choices to 'Abstain'", () => {
      expect(normalizeVoteChoice("abstain")).toBe("Abstain");
      expect(normalizeVoteChoice("ABSTAIN")).toBe("Abstain");
      expect(normalizeVoteChoice("Abstain ")).toBe("Abstain");
      expect(normalizeVoteChoice("pass")).toBe("Abstain");
    });

    it("returns null for unknown choices", () => {
      expect(normalizeVoteChoice("invalid_choice")).toBeNull();
    });
  });

  describe("calculateVoteWeights", () => {
    it("calculates exact total participating vote weight V_total = V_for + V_against + V_abstain", () => {
      const votes = [
        { choice: "For", weight: "100.5" },
        { choice: "For", weight: "50.25" },
        { choice: "Against", weight: "30.125" },
        { choice: "Abstain", weight: "19.125" },
      ];

      const { breakdown } = calculateVoteWeights(votes);

      expect(breakdown.forWeight).toBe("150.75");
      expect(breakdown.againstWeight).toBe("30.125");
      expect(breakdown.abstainWeight).toBe("19.125");
      // 150.75 + 30.125 + 19.125 = 200
      expect(breakdown.totalWeight).toBe("200");
      expect(breakdown.forCount).toBe(2);
      expect(breakdown.againstCount).toBe(1);
      expect(breakdown.abstainCount).toBe(1);
      expect(breakdown.totalVoters).toBe(4);
    });

    it("handles arbitrary 18-decimal fixed-point precision without floating-point drift", () => {
      const votes = [
        { choice: "For", weight: "100000000000000000.000000000000000001" },
        { choice: "Against", weight: "50000000000000000.000000000000000002" },
        { choice: "Abstain", weight: "25000000000000000.000000000000000003" },
      ];

      const { breakdown } = calculateVoteWeights(votes);

      expect(breakdown.forWeight).toBe("100000000000000000.000000000000000001");
      expect(breakdown.againstWeight).toBe("50000000000000000.000000000000000002");
      expect(breakdown.abstainWeight).toBe("25000000000000000.000000000000000003");
      expect(breakdown.totalWeight).toBe("175000000000000000.000000000000000006");
    });

    it("handles zero votes properly", () => {
      const { breakdown } = calculateVoteWeights([]);

      expect(breakdown.forWeight).toBe("0");
      expect(breakdown.againstWeight).toBe("0");
      expect(breakdown.abstainWeight).toBe("0");
      expect(breakdown.totalWeight).toBe("0");
      expect(breakdown.totalVoters).toBe(0);
    });
  });

  describe("extractRequiredQuorum", () => {
    it("extracts from proposal.quorumThreshold", () => {
      const q = extractRequiredQuorum({
        proposalId: "p-1",
        expiresAt: new Date(),
        status: "Queued",
        quorumThreshold: "50000",
      });
      expect(q).toBe("50000");
    });

    it("extracts from actionData JSON string", () => {
      const q = extractRequiredQuorum({
        proposalId: "p-2",
        expiresAt: new Date(),
        status: "Active",
        actionData: JSON.stringify({ quorumThreshold: "75000" }),
      });
      expect(q).toBe("75000");
    });

    it("falls back to default threshold if not specified", () => {
      const q = extractRequiredQuorum(
        {
          proposalId: "p-3",
          expiresAt: new Date(),
          status: "Queued",
        },
        "1000",
      );
      expect(q).toBe("1000");
    });
  });

  describe("evaluateProposal", () => {
    const service = new GovernanceQuorumVerificationService({
      defaultQuorumThreshold: "100",
    });

    it("marks proposal as SUCCEEDED when quorum is met and votes for exceed votes against", () => {
      const proposal = {
        proposalId: "prop-success",
        expiresAt: new Date(Date.now() - 1000), // expired
        status: "Active",
        quorumThreshold: "100",
      };
      const votes = [
        { choice: "For", weight: "70" },
        { choice: "Against", weight: "20" },
        { choice: "Abstain", weight: "20" },
      ];

      const result = service.evaluateProposal(proposal, votes);

      expect(result.quorumMet).toBe(true);
      expect(result.majorityMet).toBe(true);
      expect(result.finalStatus).toBe("SUCCEEDED");
      expect(result.totalParticipatingWeight).toBe("110");
      expect(result.isExpired).toBe(true);
    });

    it("marks proposal as DEFEATED when quorum is NOT met even if votes for exceed against", () => {
      const proposal = {
        proposalId: "prop-no-quorum",
        expiresAt: new Date(Date.now() - 1000),
        status: "Active",
        quorumThreshold: "100",
      };
      const votes = [
        { choice: "For", weight: "50" },
        { choice: "Against", weight: "10" },
        { choice: "Abstain", weight: "10" },
      ];

      const result = service.evaluateProposal(proposal, votes);

      expect(result.totalParticipatingWeight).toBe("70");
      expect(result.quorumMet).toBe(false);
      expect(result.majorityMet).toBe(true);
      expect(result.finalStatus).toBe("DEFEATED");
      expect(result.reason).toContain("Quorum threshold not met");
    });

    it("marks proposal as DEFEATED when quorum is met but votes against exceed votes for", () => {
      const proposal = {
        proposalId: "prop-rejected",
        expiresAt: new Date(Date.now() - 1000),
        status: "Active",
        quorumThreshold: "100",
      };
      const votes = [
        { choice: "For", weight: "40" },
        { choice: "Against", weight: "70" },
        { choice: "Abstain", weight: "10" },
      ];

      const result = service.evaluateProposal(proposal, votes);

      expect(result.totalParticipatingWeight).toBe("120");
      expect(result.quorumMet).toBe(true);
      expect(result.majorityMet).toBe(false);
      expect(result.finalStatus).toBe("DEFEATED");
      expect(result.reason).toContain("votes against (70) exceed votes in favor (40)");
    });

    it("marks proposal as DEFEATED when quorum is met but votes tie", () => {
      const proposal = {
        proposalId: "prop-tie",
        expiresAt: new Date(Date.now() - 1000),
        status: "Active",
        quorumThreshold: "100",
      };
      const votes = [
        { choice: "For", weight: "50" },
        { choice: "Against", weight: "50" },
        { choice: "Abstain", weight: "10" },
      ];

      const result = service.evaluateProposal(proposal, votes);

      expect(result.quorumMet).toBe(true);
      expect(result.majorityMet).toBe(false);
      expect(result.finalStatus).toBe("DEFEATED");
      expect(result.reason).toContain("tied with votes against");
    });

    it("correctly counts abstain votes toward quorum but not toward majority", () => {
      const proposal = {
        proposalId: "prop-abstain-impact",
        expiresAt: new Date(Date.now() - 1000),
        status: "Active",
        quorumThreshold: "100",
      };
      // For (45) + Against (30) + Abstain (35) = 110 (meets 100 quorum).
      // For (45) > Against (30) -> majority met!
      const votes = [
        { choice: "For", weight: "45" },
        { choice: "Against", weight: "30" },
        { choice: "Abstain", weight: "35" },
      ];

      const result = service.evaluateProposal(proposal, votes);

      expect(result.totalParticipatingWeight).toBe("110");
      expect(result.quorumMet).toBe(true);
      expect(result.majorityMet).toBe(true);
      expect(result.finalStatus).toBe("SUCCEEDED");
    });
  });

  describe("Database Integration & Expiration Verification", () => {
    let service: GovernanceQuorumVerificationService;

    beforeEach(() => {
      mockFindMany.mockReset();
      mockFindUnique.mockReset();
      mockUpdate.mockReset().mockResolvedValue({});
      mockBroadcastVoteUpdate.mockReset();
      mockBroadcastTimelockStatus.mockReset();

      service = new GovernanceQuorumVerificationService({
        defaultQuorumThreshold: "100",
      });
    });

    afterEach(() => {
      service.stop();
    });

    it("verifyExpiredProposals queries active expired proposals and updates them to SUCCEEDED or DEFEATED", async () => {
      const now = new Date("2026-10-17T12:00:00Z");
      const expiredProposal1 = {
        id: 1,
        proposalId: "prop-succeed-1",
        expiresAt: new Date("2026-10-17T11:00:00Z"),
        status: "Active",
        quorumThreshold: "100",
        votes: [
          { choice: "For", weight: "80" },
          { choice: "Against", weight: "30" },
        ],
      };

      const expiredProposal2 = {
        id: 2,
        proposalId: "prop-defeat-quorum",
        expiresAt: new Date("2026-10-17T10:00:00Z"),
        status: "Queued",
        quorumThreshold: "200",
        votes: [
          { choice: "For", weight: "120" },
          { choice: "Against", weight: "10" },
        ],
      };

      mockFindMany.mockResolvedValue([expiredProposal1, expiredProposal2]);

      const results = await service.verifyExpiredProposals(now);

      expect(mockFindMany).toHaveBeenCalledWith({
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

      expect(results).toHaveLength(2);
      expect(results[0].proposalId).toBe("prop-succeed-1");
      expect(results[0].finalStatus).toBe("SUCCEEDED");
      expect(results[1].proposalId).toBe("prop-defeat-quorum");
      expect(results[1].finalStatus).toBe("DEFEATED");

      expect(mockUpdate).toHaveBeenCalledTimes(2);
      expect(mockUpdate).toHaveBeenNthCalledWith(1, {
        where: { proposalId: "prop-succeed-1" },
        data: {
          status: "SUCCEEDED",
          updatedAt: now,
        },
      });
      expect(mockUpdate).toHaveBeenNthCalledWith(2, {
        where: { proposalId: "prop-defeat-quorum" },
        data: {
          status: "DEFEATED",
          updatedAt: now,
        },
      });

      expect(mockBroadcastVoteUpdate).toHaveBeenCalled();
    });

    it("verifyProposal updates single proposal if expired", async () => {
      const now = new Date("2026-10-17T12:00:00Z");
      const proposal = {
        id: 10,
        proposalId: "prop-expired",
        expiresAt: new Date("2026-10-17T11:59:00Z"),
        status: "Active",
        quorumThreshold: "50",
        votes: [
          { choice: "For", weight: "60" },
          { choice: "Against", weight: "10" },
        ],
      };

      mockFindUnique.mockResolvedValue(proposal);

      const result = await service.verifyProposal("prop-expired", { now });

      expect(result).not.toBeNull();
      expect(result?.finalStatus).toBe("SUCCEEDED");
      expect(mockUpdate).toHaveBeenCalledWith({
        where: { proposalId: "prop-expired" },
        data: {
          status: "SUCCEEDED",
          updatedAt: now,
        },
      });
    });

    it("verifyProposal does not update database if proposal has NOT expired and forceResolution is false", async () => {
      const now = new Date("2026-10-17T12:00:00Z");
      const activeProposal = {
        id: 11,
        proposalId: "prop-active",
        expiresAt: new Date("2026-10-17T15:00:00Z"), // future
        status: "Active",
        quorumThreshold: "50",
        votes: [
          { choice: "For", weight: "60" },
          { choice: "Against", weight: "10" },
        ],
      };

      mockFindUnique.mockResolvedValue(activeProposal);

      const result = await service.verifyProposal("prop-active", { now });

      expect(result).not.toBeNull();
      expect(result?.isExpired).toBe(false);
      expect(mockUpdate).not.toHaveBeenCalled();
    });
  });

  describe("Lifecycle and Scheduling", () => {
    it("starts and stops background interval timer", async () => {
      mockFindMany.mockResolvedValue([]);

      const service = new GovernanceQuorumVerificationService({
        pollIntervalMs: 50,
      });

      expect(service.isRunning()).toBe(false);
      await service.start();
      expect(service.isRunning()).toBe(true);

      expect(mockFindMany).toHaveBeenCalled();

      service.stop();
      expect(service.isRunning()).toBe(false);
    });
  });
});
