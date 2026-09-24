import {
  describe,
  it,
  expect,
  beforeEach,
  jest,
} from "@jest/globals";

jest.unstable_mockModule("../src/lib/prisma", () => ({
  default: {
    timelockEvent: {
      upsert: jest.fn(() => Promise.resolve({})),
      findFirst: jest.fn(() => Promise.resolve(null)),
    },
    governanceProposal: {
      upsert: jest.fn(() => Promise.resolve({})),
      update: jest.fn(() => Promise.resolve({})),
    },
    $executeRaw: jest.fn(() => Promise.resolve(1)),
    $queryRaw: jest.fn(() => Promise.resolve([])),
  },
}));

jest.unstable_mockModule("../src/lib/stellarProvider", () => {
  const getEvents = jest.fn(() => Promise.resolve({ events: [] }));
  return {
    default: {
      getRpcServer: () => ({ getEvents }),
      getServer: jest.fn(),
      reportFailure: jest.fn(),
    },
  };
});

jest.unstable_mockModule("../src/services/stellarService", () => ({
  StellarService: jest.fn(() => ({
    executeGovernanceProposal: jest.fn(),
  })),
}));

jest.unstable_mockModule("../src/services/notificationService", () => ({
  notificationService: {
    sendGovernanceTimelockReadyAlert: jest.fn(() => Promise.resolve(true)),
  },
  AlertType: { GOVERNANCE_TIMELOCK_READY: "governance_timelock_ready" },
  AlertSeverity: { HIGH: "high" },
}));

jest.unstable_mockModule("../src/services/governanceWebhookBroadcaster", () => ({
  governanceWebhookBroadcaster: {
    broadcastProposalExecuted: jest.fn(() => Promise.resolve([])),
    broadcastProposalCancelled: jest.fn(() => Promise.resolve([])),
    broadcastProposalExpired: jest.fn(() => Promise.resolve([])),
  },
}));

jest.unstable_mockModule("../src/utils/logger", () => ({
  logger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
}));

const prismaMock = await import("../src/lib/prisma");
const stellarProviderMock = await import("../src/lib/stellarProvider");
const broadcasterMock = await import(
  "../src/services/governanceWebhookBroadcaster"
);
const { GovernanceTimelockService } = await import(
  "../src/services/governanceTimelockService"
);
const { TimelockService } = await import("../src/services/timelockService");

const mockTimelockEventUpsert = (prismaMock.default as any).timelockEvent
  .upsert;
const mockTimelockEventFindFirst = (prismaMock.default as any).timelockEvent
  .findFirst;
const mockGovernanceProposalUpsert = (prismaMock.default as any)
  .governanceProposal.upsert;
const mockGovernanceProposalUpdate = (prismaMock.default as any)
  .governanceProposal.update;
const mockExecuteRaw = (prismaMock.default as any).$executeRaw;
const mockQueryRaw = (prismaMock.default as any).$queryRaw;
const mockGetEvents = (stellarProviderMock.default as any)
  .getRpcServer().getEvents;
const mockBroadcastProposalExecuted = (broadcasterMock.governanceWebhookBroadcaster as any)
  .broadcastProposalExecuted;
const mockBroadcastProposalCancelled = (broadcasterMock.governanceWebhookBroadcaster as any)
  .broadcastProposalCancelled;
const mockBroadcastProposalExpired = (broadcasterMock.governanceWebhookBroadcaster as any)
  .broadcastProposalExpired;

function makeEvent(eventName: string, proposalId: string, contractId = "CONTRACT_A") {
  return {
    type: "contract",
    ledger: 1000,
    ledgerClosedAt: new Date().toISOString(),
    txHash: "tx-1",
    contractId,
    topic: [eventName, proposalId],
    value: null,
  };
}

describe("governance webhook integration hooks", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockTimelockEventFindFirst.mockResolvedValue(null);
    mockGetEvents.mockResolvedValue({ events: [] });
    mockTimelockEventUpsert.mockResolvedValue({});
    mockGovernanceProposalUpsert.mockResolvedValue({});
    mockGovernanceProposalUpdate.mockResolvedValue({});
    mockExecuteRaw.mockResolvedValue(1);
    mockQueryRaw.mockResolvedValue([]);
    mockBroadcastProposalExecuted.mockResolvedValue([]);
    mockBroadcastProposalCancelled.mockResolvedValue([]);
    mockBroadcastProposalExpired.mockResolvedValue([]);
  });

  it("broadcasts proposal.executed when a TimelockActionExecuted event is indexed", async () => {
    const service = new GovernanceTimelockService(60_000);
    mockGetEvents.mockResolvedValue({
      events: [makeEvent("TimelockActionExecuted", "prop-77", "CONTRACT_B")],
    });

    await service.indexContractEvents("CONTRACT_B");
    service.stop();

    expect(mockBroadcastProposalExecuted).toHaveBeenCalledTimes(1);
    expect(mockBroadcastProposalExecuted).toHaveBeenCalledWith(
      expect.objectContaining({
        proposalId: "prop-77",
        contractId: "CONTRACT_B",
        status: "Executed",
      }),
    );
  });

  it("broadcasts proposal.expired for execution-ready proposals", async () => {
    const service = new GovernanceTimelockService(60_000);
    const expiresAt = new Date(Date.now() - 60_000);
    mockQueryRaw.mockResolvedValue([
      {
        id: 1,
        proposalId: "prop-ready",
        contractId: "CONTRACT_A",
        expiresAt,
        notificationCount: 0,
      },
    ]);

    await service.notifyReadyProposals();
    service.stop();

    expect(mockBroadcastProposalExpired).toHaveBeenCalledTimes(1);
    expect(mockBroadcastProposalExpired).toHaveBeenCalledWith(
      expect.objectContaining({
        proposalId: "prop-ready",
        contractId: "CONTRACT_A",
        reason: "timelock_expired",
      }),
    );
  });

  it("broadcasts proposal.cancelled when a timelock action is cancelled", async () => {
    const cancelledAt = new Date();
    mockQueryRaw.mockResolvedValueOnce([
      {
        id: 5,
        proposalId: "prop-cancel",
        contractId: "CONTRACT_A",
        actionType: "UPGRADE",
        actionData: null,
        status: "Cancelled",
        expiresAt: new Date(),
        transactionHash: null,
        executedAt: null,
        cancelledAt,
        createdAt: new Date(),
        updatedAt: cancelledAt,
      },
    ]);

    const timelockService = new TimelockService();
    const result = await timelockService.cancelAction(5);

    expect(result?.status).toBe("Cancelled");
    expect(mockBroadcastProposalCancelled).toHaveBeenCalledTimes(1);
    expect(mockBroadcastProposalCancelled).toHaveBeenCalledWith(
      expect.objectContaining({
        proposalId: "prop-cancel",
        contractId: "CONTRACT_A",
        status: "Cancelled",
      }),
    );
  });

  it("does not broadcast when the cancellation matches no queued proposal", async () => {
    mockQueryRaw.mockResolvedValueOnce([]);
    const timelockService = new TimelockService();
    const result = await timelockService.cancelAction(999);

    expect(result).toBeNull();
    expect(mockBroadcastProposalCancelled).not.toHaveBeenCalled();
  });
});
