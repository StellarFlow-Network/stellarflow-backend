import { describe, it, expect, beforeEach, jest } from "@jest/globals";
import { TransactionBuilder, Account, Operation, Contract, nativeToScVal } from "@stellar/stellar-sdk";
import { GovernanceProposalPayloadValidator } from "../src/services/governanceProposalPayloadValidator";

const mockSimulateTransaction = jest.fn<() => Promise<any>>();
const mockPrismaGovernanceProposalUpdate = jest.fn<() => Promise<any>>();
const mockSendAlert = jest.fn<() => Promise<boolean>>();

jest.mock("../src/lib/prisma", () => ({
  __esModule: true,
  default: {
    governanceProposal: {
      update: mockPrismaGovernanceProposalUpdate,
    },
  },
}));

jest.mock("../src/services/notificationService", () => ({
  __esModule: true,
  notificationService: {
    sendAlert: mockSendAlert,
  },
  AlertType: { GOVERNANCE_TIMELOCK_READY: "governance_timelock_ready" },
  AlertSeverity: { HIGH: "high" },
}));

describe("GovernanceProposalPayloadValidator", () => {
  let validator: GovernanceProposalPayloadValidator;
  let dummyTx: any;

  beforeEach(() => {
    jest.clearAllMocks();
    const mockRpcServer: any = {
      simulateTransaction: mockSimulateTransaction,
    };
    validator = new GovernanceProposalPayloadValidator(mockRpcServer);

    const account = new Account("GBRPYHIL2CI3FNQ4BXLFMNDLFJUNPU2HY3ZMFSHONUCEOASSSGBCFP45", "1");
    dummyTx = new TransactionBuilder(account, {
      fee: "100",
      networkPassphrase: "Test SDF Network ; September 2015",
    })
      .addOperation(
        new Contract("C1234567890123456789012345678901234567890123456789012345").call(
          "execute",
          nativeToScVal(1n, { type: "u64" }),
        ),
      )
      .setTimeout(30)
      .build();
  });

  it("should validate successfully when simulation succeeds without revert or out-of-gas", async () => {
    mockSimulateTransaction.mockResolvedValueOnce({
      result: { retval: nativeToScVal(true) },
    } as any);

    const futureDate = new Date(Date.now() + 3600_000);
    const report = await validator.validateAndFlagProposal({
      id: 1,
      proposalId: "prop-1",
      contractId: "C1234567890123456789012345678901234567890123456789012345",
      transaction: dummyTx,
      expiresAt: futureDate,
    });

    expect(report.isValid).toBe(true);
    expect(report.simulatedSuccessfully).toBe(true);
    expect(report.reverted).toBe(false);
    expect(report.outOfGas).toBe(false);
    expect(mockPrismaGovernanceProposalUpdate).not.toHaveBeenCalled();
  });

  it("should flag proposal when simulation fails with revert error before expiration", async () => {
    mockSimulateTransaction.mockResolvedValueOnce({
      error: "HostError: Error(Contract, #1)",
    } as any);

    mockPrismaGovernanceProposalUpdate.mockResolvedValueOnce({});
    mockSendAlert.mockResolvedValueOnce(true);

    const futureDate = new Date(Date.now() + 3600_000);
    const report = await validator.validateAndFlagProposal({
      id: 2,
      proposalId: "prop-2",
      contractId: "C1234567890123456789012345678901234567890123456789012345",
      transaction: dummyTx,
      expiresAt: futureDate,
    });

    expect(report.isValid).toBe(false);
    expect(report.reverted).toBe(true);
    expect(report.outOfGas).toBe(false);
    expect(mockPrismaGovernanceProposalUpdate).toHaveBeenCalledTimes(1);
    expect(mockSendAlert).toHaveBeenCalledTimes(1);
  });
});
