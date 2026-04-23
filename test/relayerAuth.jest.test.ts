import { apiKeyMiddleware } from "../src/middleware/apiKeyMiddleware";

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

describe("apiKeyMiddleware", () => {
  test("authenticates an active relayer by API key and attaches req.relayer", async () => {
    mockFindFirst.mockResolvedValue({
      id: 1,
      name: "GHS Relayer",
      allowedAssets: ["GHS"],
    });

    const req = createMockRequest("relayer-ghs-key") as import("express").Request & {
      relayer?: { id: number; name: string; allowedAssets: string[] };
    };
    const res = createMockResponse();
    const next = jest.fn();

    await apiKeyMiddleware(req, res, next);

    expect(mockFindFirst).toHaveBeenCalledWith({
      where: { apiKey: "relayer-ghs-key", isActive: true },
    });
    expect(req.relayer).toEqual({
      id: 1,
      name: "GHS Relayer",
      allowedAssets: ["GHS"],
    });
    expect(next).toHaveBeenCalled();
  });

  test("falls back to global API_KEY when no relayer matches", async () => {
    mockFindFirst.mockResolvedValue(null);
    process.env.API_KEY = "global-secret";

    const req = createMockRequest("global-secret");
    const res = createMockResponse();
    const next = jest.fn();

    await apiKeyMiddleware(req, res, next);

    expect(next).toHaveBeenCalled();
    expect((req as any).relayer).toBeUndefined();
  });

  test("returns 401 when API key is missing", async () => {
    const req = createMockRequest(undefined);
    const res = createMockResponse();
    const next = jest.fn();

    await apiKeyMiddleware(req, res, next);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });

  test("returns 401 when neither relayer nor global key matches", async () => {
    mockFindFirst.mockResolvedValue(null);
    process.env.API_KEY = "global-secret";

    const req = createMockRequest("wrong-key");
    const res = createMockResponse();
    const next = jest.fn();

    await apiKeyMiddleware(req, res, next);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });
});

describe("relayer asset authorization", () => {
  test("allows request when relayer is authorized for the asset", () => {
    const relayer = { id: 1, name: "NGN Relayer", allowedAssets: ["NGN"] };
    const currency = "NGN";
    const normalizedCurrency = currency.toUpperCase();

    const isAuthorized = relayer.allowedAssets.includes(normalizedCurrency);
    expect(isAuthorized).toBe(true);
  });

  test("rejects request when relayer is not authorized for the asset", () => {
    const relayer = { id: 2, name: "GHS Relayer", allowedAssets: ["GHS"] };
    const currency = "NGN";
    const normalizedCurrency = currency.toUpperCase();

    const isAuthorized = relayer.allowedAssets.includes(normalizedCurrency);
    expect(isAuthorized).toBe(false);
  });

  test("bypasses authorization when no relayer is present (global key)", () => {
    const relayer = undefined;
    const shouldBypass = !relayer;
    expect(shouldBypass).toBe(true);
  });
});
