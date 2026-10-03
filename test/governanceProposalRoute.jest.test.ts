import express from "express";
import type { Server } from "http";
import type { AddressInfo } from "net";
import {
  describe,
  it,
  expect,
  beforeEach,
  afterEach,
  jest,
} from "@jest/globals";

const mockGetProposalResultDetail =
  jest.fn<(proposalId: string) => Promise<unknown>>();

// The governance router pulls in the voter controller, which needs the Prisma
// client; the client is not generated in unit test runs, so it is stubbed.
jest.unstable_mockModule("../src/lib/prisma", () => ({
  __esModule: true,
  default: {},
}));

jest.unstable_mockModule("../src/services/governanceResultService.js", () => ({
  __esModule: true,
  getProposalResultDetail: (proposalId: string) =>
    mockGetProposalResultDetail(proposalId),
}));

const { default: governanceRouter } =
  await import("../src/routes/governance.js");

const DETAIL = {
  proposal: {
    proposalId: "42",
    contractId: "CGOVERNANCE",
    title: "Raise staking rewards",
    actionType: "UpdateConfig",
    status: "Executed",
    expiresAt: "2026-09-05T00:00:00.000Z",
    queuedAt: "2026-09-04T00:00:00.000Z",
    executedAt: "2026-09-06T00:00:00.000Z",
    cancelledAt: null,
    transactionHash: "deadbeef",
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-09-06T00:00:00.000Z",
  },
  tally: {
    totalVoters: 2,
    totalWeight: "12.75",
    byChoice: {
      Against: { votes: 1, weight: "2.25" },
      For: { votes: 1, weight: "10.5" },
    },
  },
  voterCount: 2,
  resultExport: {
    cid: "bafybeigdyrzt8s",
    contentHash: "c".repeat(64),
    exportedAt: "2026-09-07T08:30:00.000Z",
  },
};

let server: Server;
let baseUrl: string;
const originalGatewayUrl = process.env.IPFS_GATEWAY_URL;

beforeEach(async () => {
  mockGetProposalResultDetail.mockReset();
  process.env.IPFS_GATEWAY_URL = "https://gateway.example/ipfs";

  const app = express();
  app.use("/api/v1/governance", governanceRouter);
  server = app.listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  const { port } = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${port}/api/v1/governance`;
});

afterEach(async () => {
  if (originalGatewayUrl === undefined) {
    delete process.env.IPFS_GATEWAY_URL;
  } else {
    process.env.IPFS_GATEWAY_URL = originalGatewayUrl;
  }
  await new Promise((resolve) => server.close(resolve));
});

describe("GET /api/v1/governance/proposals/:proposal_id", () => {
  it("returns the result tally with the IPFS verification link", async () => {
    mockGetProposalResultDetail.mockResolvedValue(DETAIL);

    const res = await fetch(`${baseUrl}/proposals/42`);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.data.proposal.proposalId).toBe("42");
    expect(body.data.tally.totalWeight).toBe("12.75");
    expect(body.data.voterCount).toBe(2);
    expect(body.data.verification).toEqual({
      cid: "bafybeigdyrzt8s",
      contentHash: "c".repeat(64),
      exportedAt: "2026-09-07T08:30:00.000Z",
      url: "https://gateway.example/ipfs/bafybeigdyrzt8s",
    });
    expect(mockGetProposalResultDetail).toHaveBeenCalledWith("42");
  });

  it("returns a null verification block before the snapshot is exported", async () => {
    mockGetProposalResultDetail.mockResolvedValue({
      ...DETAIL,
      resultExport: null,
    });

    const res = await fetch(`${baseUrl}/proposals/42`);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.data.verification).toBeNull();
  });

  it("accepts proposal identifiers containing dots and colons", async () => {
    mockGetProposalResultDetail.mockResolvedValue({
      ...DETAIL,
      resultExport: null,
    });

    const res = await fetch(`${baseUrl}/proposals/prop:1.2`);

    expect(res.status).toBe(200);
    expect(mockGetProposalResultDetail).toHaveBeenCalledWith("prop:1.2");
  });

  it("404s when the proposal does not exist", async () => {
    mockGetProposalResultDetail.mockResolvedValue(null);

    const res = await fetch(`${baseUrl}/proposals/unknown`);
    const body = await res.json();

    expect(res.status).toBe(404);
    expect(body.error.code).toBe("NOT_FOUND");
  });

  it("400s on a malformed proposal identifier", async () => {
    const res = await fetch(
      `${baseUrl}/proposals/${encodeURIComponent("bad$id!")}`,
    );
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(body.error.code).toBe("BAD_REQUEST");
    expect(mockGetProposalResultDetail).not.toHaveBeenCalled();
  });
});
