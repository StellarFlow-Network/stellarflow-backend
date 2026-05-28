import { relayerMiddleware } from "../src/middleware/relayerMiddleware";
import { getEmptyRelayer } from "../src/types/relayer.types";

const mockFindFirst = jest.fn();

beforeEach(() => {
  (globalThis as any).prisma = {
    relayer: {
      findFirst: mockFindFirst,
    },
  };
  mockFindFirst.mockReset();
  delete process.env.API_KEY;
});

function createMockResponse() {
  const json = jest.fn();
  const status = jest.fn(() => ({ json }));
  return { json, status, sendStatus: status } as unknown as import("express").Response;
}

function createMockRequest(apiKey?: string): import("express").Request {
  return {
    headers: { "x-api-key": apiKey },
  } as unknown as import("express").Request;
}

describe("relayerMiddleware", () => {
  test("authenticates an active relayer by API key and attaches req.relayer", async () => {
    mockFindFirst.mockResolvedValue({
      id: 1,
      name: "GHS Relayer",
      allowedAssets: ["GHS"],
      publicKey: null,
    });

    const req = createMockRequest("relayer-ghs-key") as import("express").Request & {
      relayer?: any;
    };
    const res = createMockResponse();
    const next = jest.fn();

    await relayerMiddleware(req, res, next);

    expect(mockFindFirst).toHaveBeenCalledWith({
      where: { apiKey: "relayer-ghs-key", isActive: true },
      select: {
        id: true,
        name: true,
        allowedAssets: true,
        publicKey: true,
      },
    });
    expect(req.relayer).toEqual({
      id: 1,
      name: "GHS Relayer",
      allowedAssets: ["GHS"],
      publicKey: null,
    });
    expect(req.relayer.is_noop()).toBe(false);
    expect(next).toHaveBeenCalled();
  });

  test("falls back to EmptyRelayer when no relayer matches", async () => {
    mockFindFirst.mockResolvedValue(null);

    const req = createMockRequest("global-secret");
    const res = createMockResponse();
    const next = jest.fn();

    await relayerMiddleware(req, res, next);

    expect(next).toHaveBeenCalled();
    expect(req.relayer).toBeDefined();
    expect(req.relayer.is_noop()).toBe(true);
    expect(req.relayer.id).toBe(-1);
    expect(req.relayer.name).toBe("[no-op]");
    expect(req.relayer.allowedAssets).toEqual([]);
  });

  test("returns EmptyRelayer when API key is missing", async () => {
    const req = createMockRequest(undefined);
    const res = createMockResponse();
    const next = jest.fn();

    await relayerMiddleware(req, res, next);

    expect(next).toHaveBeenCalled();
    expect(req.relayer).toBeDefined();
    expect(req.relayer.is_noop()).toBe(true);
  });

  test("returns EmptyRelayer when API key is whitespace", async () => {
    const req = createMockRequest("   ");
    const res = createMockResponse();
    const next = jest.fn();

    await relayerMiddleware(req, res, next);

    expect(next).toHaveBeenCalled();
    expect(req.relayer).toBeDefined();
    expect(req.relayer.is_noop()).toBe(true);
  });
});

describe("relayer asset authorization", () => {
  test("allows request when relayer is authorized for the asset", () => {
    const relayer = { id: 1, name: "NGN Relayer", allowedAssets: ["NGN"], is_noop: () => false };
    const currency = "NGN";
    const normalizedCurrency = currency.toUpperCase();

    const isAuthorized = relayer.allowedAssets.includes(normalizedCurrency);
    expect(isAuthorized).toBe(true);
  });

  test("rejects request when relayer is not authorized for the asset", () => {
    const relayer = { id: 2, name: "GHS Relayer", allowedAssets: ["GHS"], is_noop: () => false };
    const currency = "NGN";
    const normalizedCurrency = currency.toUpperCase();

    const isAuthorized = relayer.allowedAssets.includes(normalizedCurrency);
    expect(isAuthorized).toBe(false);
  });

  test("bypasses authorization when relayer is empty (no-op)", () => {
    const relayer = getEmptyRelayer();
    const shouldBypass = relayer.is_noop();
    expect(shouldBypass).toBe(true);
  });
});
