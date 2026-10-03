import crypto from "crypto";
import { describe, it, expect, beforeEach, jest } from "@jest/globals";

jest.unstable_mockModule("../src/lib/prisma", () => ({
  __esModule: true,
  default: {},
}));

const { GovernanceResultExportWorker, FINAL_RESULT_STATUSES } =
  await import("../src/services/governanceResultExportWorker.js");

type FindManyArgs = {
  where: Record<string, unknown>;
  orderBy: unknown;
  take: number;
  include: unknown;
};

type UpdateManyArgs = {
  where: Record<string, unknown>;
  data: Record<string, unknown>;
};

const proposalRow = {
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
  resultExportAttempts: 0,
  votes: [
    {
      accountId: "GAAAA",
      choice: "For",
      weight: "10.5",
      votedAt: new Date("2026-09-01T09:00:00.000Z"),
      txHash: "tx-1",
    },
    {
      accountId: "GZZZZ",
      choice: "Against",
      weight: "2.25",
      votedAt: new Date("2026-09-01T10:00:00.000Z"),
      txHash: null,
    },
  ],
};

function createStore(rows: unknown[]) {
  const findMany = jest
    .fn<(args: FindManyArgs) => Promise<unknown[]>>()
    .mockResolvedValue(rows);
  const updateMany = jest
    .fn<(args: UpdateManyArgs) => Promise<{ count: number }>>()
    .mockResolvedValue({ count: 1 });
  return {
    findMany,
    updateMany,
    store: { governanceProposal: { findMany, updateMany } },
  };
}

function createIpfs(options?: { configured?: boolean; cid?: string }) {
  const add = jest
    .fn<(content: Buffer, filename: string) => Promise<{ cid: string }>>()
    .mockResolvedValue({ cid: options?.cid ?? "bafyresultcid" });
  const ipfs = {
    isConfigured: () => options?.configured ?? true,
    add,
    gatewayUrl: (cid: string) => `https://ipfs.io/ipfs/${cid}`,
  };
  return { add, ipfs };
}

function createLogger() {
  return {
    info: jest.fn<(message: string) => void>(),
    warn: jest.fn<(message: string) => void>(),
    error: jest.fn<(message: string) => void>(),
  };
}

function createWorker(config: {
  rows?: unknown[];
  ipfs?: ReturnType<typeof createIpfs>["ipfs"];
  intervalMs?: number;
  batchSize?: number;
  maxAttempts?: number;
}) {
  const { findMany, updateMany, store } = createStore(config.rows ?? []);
  const { add, ipfs } = createIpfs();
  const log = createLogger();
  const worker = new GovernanceResultExportWorker({
    store,
    ipfs: config.ipfs ?? ipfs,
    intervalMs: config.intervalMs ?? 60_000,
    batchSize: config.batchSize ?? 10,
    maxAttempts: config.maxAttempts ?? 5,
    logger: log,
  });
  return { worker, findMany, updateMany, add, log, ipfs };
}

describe("GovernanceResultExportWorker", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("queries only completed, not yet exported proposals", async () => {
    const { worker, findMany } = createWorker({ rows: [] });

    await worker.runOnce();

    expect(findMany).toHaveBeenCalledTimes(1);
    const args = findMany.mock.calls[0]?.[0];
    expect(args?.where).toEqual({
      status: { in: FINAL_RESULT_STATUSES },
      resultExportCid: null,
      resultExportAttempts: { lt: 5 },
    });
    expect(args?.orderBy).toEqual({ updatedAt: "asc" });
    expect(args?.take).toBe(10);
  });

  it("publishes the snapshot and persists the IPFS CID on the proposal", async () => {
    const { worker, add, updateMany, findMany } = createWorker({
      rows: [proposalRow],
    });

    await worker.runOnce();

    expect(add).toHaveBeenCalledTimes(1);
    const [content, filename] = add.mock.calls[0] ?? [];
    expect(Buffer.isBuffer(content)).toBe(true);
    expect(filename).toBe("42-governance-result.json");

    const snapshot = JSON.parse(String(content));
    expect(snapshot.proposal.proposalId).toBe("42");
    expect(snapshot.tally).toMatchObject({
      totalVoters: 2,
      totalWeight: "12.75",
    });
    expect(
      snapshot.voters.map((voter: { accountId: string }) => voter.accountId),
    ).toEqual(["GAAAA", "GZZZZ"]);

    const expectedHash = content
      ? crypto.createHash("sha256").update(content).digest("hex")
      : "";
    expect(updateMany).toHaveBeenCalledTimes(1);
    expect(updateMany.mock.calls[0]?.[0]).toEqual({
      where: { proposalId: "42", resultExportCid: null },
      data: {
        resultExportCid: "bafyresultcid",
        resultExportContentHash: expectedHash,
        resultExportedAt: expect.any(Date),
        resultExportAttempts: 0,
        resultExportError: null,
      },
    });
    expect(findMany).toHaveBeenCalledTimes(1);
  });

  it("stays idle while no IPFS endpoint is configured", async () => {
    const { worker, findMany, add } = createWorker({
      rows: [proposalRow],
      ipfs: createIpfs({ configured: false }).ipfs,
    });

    await worker.runOnce();

    expect(findMany).not.toHaveBeenCalled();
    expect(add).not.toHaveBeenCalled();
  });

  it("warns instead of polling when started without IPFS configuration", () => {
    const { worker, findMany, log } = createWorker({
      rows: [proposalRow],
      ipfs: createIpfs({ configured: false }).ipfs,
      intervalMs: 5,
    });

    worker.start();
    worker.stop();

    expect(findMany).not.toHaveBeenCalled();
    expect(log.warn).toHaveBeenCalledWith(
      expect.stringContaining("IPFS_API_URL is not configured"),
    );
  });

  it("records the failed attempt when the IPFS upload fails", async () => {
    const ipfs = createIpfs();
    ipfs.add.mockRejectedValue(new Error("connection refused"));
    const { worker, updateMany, log } = createWorker({
      rows: [{ ...proposalRow, resultExportAttempts: 2 }],
      ipfs: ipfs.ipfs,
    });

    await worker.runOnce();

    expect(updateMany).toHaveBeenCalledTimes(1);
    expect(updateMany.mock.calls[0]?.[0]).toEqual({
      where: { proposalId: "42", resultExportCid: null },
      data: {
        resultExportAttempts: 3,
        resultExportError: "connection refused",
      },
    });
    expect(log.error).toHaveBeenCalledWith(
      expect.stringContaining("attempt 3/5"),
    );
  });

  it("keeps a CID written by a concurrent worker", async () => {
    const { worker, updateMany, log } = createWorker({ rows: [proposalRow] });
    updateMany.mockResolvedValue({ count: 0 });

    await worker.runOnce();

    expect(updateMany).toHaveBeenCalledTimes(1);
    expect(log.warn).toHaveBeenCalledWith(
      expect.stringContaining("exported concurrently"),
    );
  });

  it("ignores overlapping runs while a batch is in flight", async () => {
    let release: (rows: unknown[]) => void = () => undefined;
    const pending = new Promise<unknown[]>((resolve) => {
      release = resolve;
    });
    const { worker, findMany } = createWorker({ rows: [] });
    findMany.mockReturnValue(pending as Promise<unknown[]>);

    const first = worker.runOnce();
    const second = worker.runOnce();
    release([]);

    await Promise.all([first, second]);
    expect(findMany).toHaveBeenCalledTimes(1);
  });

  it("polls on start and stops polling on stop", async () => {
    const { worker, findMany } = createWorker({
      rows: [],
      intervalMs: 5,
    });

    worker.start();
    await new Promise((resolve) => setTimeout(resolve, 40));
    worker.stop();
    const callsAtStop = findMany.mock.calls.length;
    await new Promise((resolve) => setTimeout(resolve, 40));

    expect(callsAtStop).toBeGreaterThanOrEqual(2);
    expect(findMany.mock.calls.length).toBe(callsAtStop);
  });
});
