import {
  describe,
  it,
  expect,
  beforeEach,
  jest,
} from "@jest/globals";

const mockSimulate = jest.fn<() => Promise<any>>();

jest.unstable_mockModule("../src/services/sorobanTransactionSimulationService", () => ({
  sorobanTransactionSimulationService: {
    simulate: mockSimulate,
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

const guardModule = await import("../src/services/governanceTimelockSimulationGuard");
const { governanceTimelockSimulationGuard } = guardModule;

describe("GovernanceTimelockSimulationGuard", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("blocks execution when transaction XDR is missing or empty", async () => {
    const res = await governanceTimelockSimulationGuard.simulateProposalExecution("");
    expect(res.allowed).toBe(false);
    expect(res.status).toBe("error");
    expect(res.error).toBeDefined();
    expect(mockSimulate).not.toHaveBeenCalled();
  });

  it("blocks execution and returns error when Soroban simulation encounters errors", async () => {
    mockSimulate.mockResolvedValue({
      status: "error",
      latestLedger: 12345,
      error: "HostError: Contract execution panicked",
    });

    const res = await governanceTimelockSimulationGuard.simulateProposalExecution("AAAA...XDR");
    expect(res.allowed).toBe(false);
    expect(res.status).toBe("error");
    expect(res.error).toContain("Contract execution panicked");
    expect(mockSimulate).toHaveBeenCalledWith("AAAA...XDR");
  });

  it("allows execution when simulation succeeds", async () => {
    mockSimulate.mockResolvedValue({
      status: "success",
      latestLedger: 12345,
      instructions: "1000",
      memoryBytes: "500",
      requiredBaseFee: "100",
    });

    const res = await governanceTimelockSimulationGuard.simulateProposalExecution("AAAA...XDR");
    expect(res.allowed).toBe(true);
    expect(res.status).toBe("success");
    expect(res.instructions).toBe("1000");
  });
});
