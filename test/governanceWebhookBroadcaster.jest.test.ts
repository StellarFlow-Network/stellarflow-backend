import {
  describe,
  it,
  expect,
  beforeEach,
  afterEach,
  jest,
} from "@jest/globals";

jest.unstable_mockModule("../src/lib/prisma", () => ({
  default: {
    $executeRawUnsafe: jest.fn(() => Promise.resolve(1)),
    $queryRawUnsafe: jest.fn(() => Promise.resolve([])),
  },
}));

jest.unstable_mockModule("../src/lib/httpClient", () => ({
  httpClient: {
    post: jest.fn(() => Promise.resolve({ status: 200, data: {} })),
  },
}));

jest.unstable_mockModule("../src/utils/logger", () => ({
  createFetcherLogger: () => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  }),
}));

const prismaModule = await import("../src/lib/prisma");
const httpModule = await import("../src/lib/httpClient");
const broadcasterModule = await import(
  "../src/services/governanceWebhookBroadcaster"
);

const {
  GovernanceWebhookBroadcasterService,
  GOVERNANCE_WEBHOOK_SIGNATURE_HEADER,
  signGovernanceWebhookPayload,
  verifyGovernanceWebhookSignature,
  normalizeGovernanceWebhookEvents,
  maskGovernanceWebhookSecret,
} = broadcasterModule;

type GovernanceWebhookEndpoint = import("../src/services/governanceWebhookBroadcaster").GovernanceWebhookEndpoint;

const mockExecuteRawUnsafe = (prismaModule.default as any).$executeRawUnsafe;
const mockQueryRawUnsafe = (prismaModule.default as any).$queryRawUnsafe;
const mockPost = (httpModule.httpClient as any).post;

const ENDPOINT_SECRET = "super-secret-key-1234567890";

function endpointRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "11111111-1111-1111-1111-111111111111",
    name: "partner",
    url: "https://partner.example.com/hooks/governance",
    secret: ENDPOINT_SECRET,
    events: ["proposal.executed", "proposal.cancelled", "proposal.expired"],
    active: true,
    created_at: new Date("2026-01-01T00:00:00Z"),
    updated_at: new Date("2026-01-01T00:00:00Z"),
    ...overrides,
  };
}

function pendingRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "22222222-2222-2222-2222-222222222222",
    endpoint_id: "11111111-1111-1111-1111-111111111111",
    endpoint_url: "https://partner.example.com/hooks/governance",
    event_type: "proposal.executed",
    proposal_id: "prop-1",
    raw_body: JSON.stringify({
      event: "proposal.executed",
      eventId: "evt-1",
      timestamp: "2026-01-01T00:00:00.000Z",
      data: { proposalId: "prop-1", status: "Executed" },
    }),
    signature: "sha256=deadbeef",
    event_id: "evt-1",
    event_timestamp: "2026-01-01T00:00:00.000Z",
    attempts: 0,
    max_attempts: 5,
    ...overrides,
  };
}

describe("governanceWebhookBroadcaster", () => {
  let service: GovernanceWebhookBroadcasterService;

  beforeEach(async () => {
    jest.clearAllMocks();
    mockExecuteRawUnsafe.mockResolvedValue(1);
    mockQueryRawUnsafe.mockImplementation((sql: unknown) => {
      const text = typeof sql === "string" ? sql : "";
      if (text.includes("INSERT INTO governance_webhook_endpoints")) {
        return Promise.resolve([endpointRow()]);
      }
      if (text.includes("COUNT(*)")) {
        return Promise.resolve([{ count: 0 }]);
      }
      return Promise.resolve([]);
    });
    mockPost.mockResolvedValue({ status: 200, data: { received: true } });

    service = new GovernanceWebhookBroadcasterService(60_000);
    await (service as any).ensureTables();
  });

  afterEach(() => {
    service.stop();
  });

  describe("signature helpers", () => {
    it("signs the raw body with HMAC-SHA256 and the sha256 prefix", () => {
      const signature = signGovernanceWebhookPayload("hello", ENDPOINT_SECRET);
      expect(signature).toMatch(/^sha256=[0-9a-f]{64}$/);
    });

    it("verifies a signature produced with the same secret", () => {
      const body = JSON.stringify({ a: 1 });
      const signature = signGovernanceWebhookPayload(body, ENDPOINT_SECRET);
      expect(
        verifyGovernanceWebhookSignature(body, signature, ENDPOINT_SECRET),
      ).toBe(true);
    });

    it("accepts an unprefixed hex signature", () => {
      const body = "payload";
      const signature = signGovernanceWebhookPayload(
        body,
        ENDPOINT_SECRET,
      ).replace("sha256=", "");
      expect(
        verifyGovernanceWebhookSignature(body, signature, ENDPOINT_SECRET),
      ).toBe(true);
    });

    it("rejects a tampered body", () => {
      const signature = signGovernanceWebhookPayload("original", ENDPOINT_SECRET);
      expect(
        verifyGovernanceWebhookSignature("tampered", signature, ENDPOINT_SECRET),
      ).toBe(false);
    });

    it("rejects a signature from a different secret", () => {
      const signature = signGovernanceWebhookPayload("body", "other-secret");
      expect(
        verifyGovernanceWebhookSignature("body", signature, ENDPOINT_SECRET),
      ).toBe(false);
    });

    it("rejects missing signatures", () => {
      expect(
        verifyGovernanceWebhookSignature("body", undefined, ENDPOINT_SECRET),
      ).toBe(false);
      expect(
        verifyGovernanceWebhookSignature("body", null, ENDPOINT_SECRET),
      ).toBe(false);
    });

    it("exposes a verifySignature instance method", () => {
      const body = "payload";
      const signature = signGovernanceWebhookPayload(body, ENDPOINT_SECRET);
      expect(service.verifySignature(body, signature, ENDPOINT_SECRET)).toBe(
        true,
      );
    });
  });

  describe("event normalization", () => {
    it("defaults to all event types", () => {
      expect(normalizeGovernanceWebhookEvents(undefined)).toEqual([
        "proposal.executed",
        "proposal.cancelled",
        "proposal.expired",
      ]);
    });

    it("normalizes aliases and removes duplicates", () => {
      expect(
        normalizeGovernanceWebhookEvents(["executed", "cancelled", "executed"]),
      ).toEqual(["proposal.executed", "proposal.cancelled"]);
    });
  });

  describe("endpoint management", () => {
    it("masks secrets", () => {
      expect(maskGovernanceWebhookSecret(ENDPOINT_SECRET)).toBe(
        "supe****7890",
      );
    });

    it("registers an endpoint and generates a secret when absent", async () => {
      const captured: any[] = [];
      mockQueryRawUnsafe.mockImplementationOnce((...args: any[]) => {
        captured.push(args);
        return Promise.resolve([endpointRow({ secret: "generated" })]);
      });

      const endpoint = await service.registerEndpoint({
        url: "https://partner.example.com/hooks/governance",
      });

      expect(endpoint.secret).toBe("generated");
      const [, id, name, url, secret] = captured[0]!;
      expect(typeof id).toBe("string");
      expect(name).toBeNull();
      expect(url).toBe("https://partner.example.com/hooks/governance");
      expect(typeof secret).toBe("string");
      expect(secret.length).toBe(64);
    });

    it("lists endpoints with masked secrets", async () => {
      mockQueryRawUnsafe.mockResolvedValueOnce([endpointRow()]);
      const endpoints = await service.listEndpoints();
      expect(endpoints).toHaveLength(1);
      expect(endpoints[0]!.secret).toBe("supe****7890");
    });

    it("deactivates an endpoint", async () => {
      mockExecuteRawUnsafe.mockResolvedValueOnce(1);
      await expect(service.deactivateEndpoint("abc")).resolves.toBe(true);
    });

    it("returns false when deactivating an unknown endpoint", async () => {
      mockExecuteRawUnsafe.mockResolvedValueOnce(0);
      await expect(service.deactivateEndpoint("abc")).resolves.toBe(false);
    });
  });

  describe("broadcast", () => {
    it("enqueues a signed delivery for each subscribed endpoint", async () => {
      mockQueryRawUnsafe.mockResolvedValueOnce([endpointRow()]);

      const before = mockExecuteRawUnsafe.mock.calls.length;
      const ids = await service.broadcastProposalExecuted({
        proposalId: "prop-42",
        contractId: "CONTRACT_A",
        status: "Executed",
      });

      expect(ids).toHaveLength(1);

      const insertCall = mockExecuteRawUnsafe.mock.calls
        .slice(before)
        .find((call) => String(call[0]).includes("INSERT INTO governance_webhook_deliveries"));
      expect(insertCall).toBeDefined();

      const rawBody = insertCall![10] as string;
      const signature = insertCall![11] as string;
      expect(signature).toBe(
        signGovernanceWebhookPayload(rawBody, ENDPOINT_SECRET),
      );

      const parsed = JSON.parse(rawBody);
      expect(parsed.event).toBe("proposal.executed");
      expect(parsed.data.proposalId).toBe("prop-42");
    });

    it("does not enqueue when the delivery already exists (idempotent)", async () => {
      mockQueryRawUnsafe.mockResolvedValueOnce([endpointRow()]);
      mockExecuteRawUnsafe.mockResolvedValueOnce(0);

      const ids = await service.broadcastProposalExecuted({
        proposalId: "prop-dupe",
        status: "Executed",
      });

      expect(ids).toEqual([]);
    });

    it("returns an empty list when no endpoints are subscribed", async () => {
      mockQueryRawUnsafe.mockResolvedValueOnce([]);
      const ids = await service.broadcastProposalCancelled({
        proposalId: "prop-none",
        status: "Cancelled",
      });
      expect(ids).toEqual([]);
    });
  });

  describe("delivery dispatch", () => {
    it("delivers a webhook with signature headers and marks it delivered", async () => {
      mockQueryRawUnsafe.mockResolvedValueOnce([pendingRow()]);

      await service.processQueue();

      expect(mockPost).toHaveBeenCalledTimes(1);
      const [url, body, config] = mockPost.mock.calls[0]!;
      expect(url).toBe("https://partner.example.com/hooks/governance");
      expect(body).toBe(pendingRow().raw_body);
      expect(config.headers[GOVERNANCE_WEBHOOK_SIGNATURE_HEADER]).toBe(
        "sha256=deadbeef",
      );
      expect(config.headers["x-stellarflow-event"]).toBe("proposal.executed");
      expect(config.headers["x-stellarflow-event-id"]).toBe("evt-1");
      expect(config.headers["x-stellarflow-timestamp"]).toBe(
        "2026-01-01T00:00:00.000Z",
      );

      const updateCall = mockExecuteRawUnsafe.mock.calls.find((call) =>
        String(call[0]).includes("SET status = 'delivered'") ||
        (String(call[0]).includes("SET status = $1") &&
          call[1] === "delivered"),
      );
      expect(updateCall).toBeDefined();
    });

    it("schedules a retry on a 500 response", async () => {
      mockQueryRawUnsafe.mockResolvedValueOnce([pendingRow()]);
      mockPost.mockResolvedValueOnce({ status: 500, data: "boom" });

      await service.processQueue();

      const retryCall = mockExecuteRawUnsafe.mock.calls.find((call) =>
        String(call[0]).includes("SET status = 'retrying'"),
      );
      expect(retryCall).toBeDefined();
      const nextAttemptAt = retryCall![5] as Date;
      expect(nextAttemptAt.getTime()).toBeGreaterThan(Date.now());
      expect(retryCall![1]).toBe(1);
    });

    it("schedules a retry on a network error", async () => {
      mockQueryRawUnsafe.mockResolvedValueOnce([pendingRow()]);
      mockPost.mockRejectedValueOnce(new Error("ECONNREFUSED"));

      await service.processQueue();

      const retryCall = mockExecuteRawUnsafe.mock.calls.find((call) =>
        String(call[0]).includes("SET status = 'retrying'"),
      );
      expect(retryCall).toBeDefined();
      expect((retryCall![4] as string)).toBe("ECONNREFUSED");
    });

    it("marks a delivery failed on a non-retryable 400 response", async () => {
      mockQueryRawUnsafe.mockResolvedValueOnce([pendingRow()]);
      mockPost.mockResolvedValueOnce({ status: 400, data: "bad request" });

      await service.processQueue();

      const failedCall = mockExecuteRawUnsafe.mock.calls.find(
        (call) => String(call[0]).includes("SET status = $1") && call[1] === "failed",
      );
      expect(failedCall).toBeDefined();
    });

    it("marks a delivery failed after exhausting attempts", async () => {
      mockQueryRawUnsafe.mockResolvedValueOnce([
        pendingRow({ attempts: 5, max_attempts: 5 }),
      ]);

      await service.processQueue();

      expect(mockPost).not.toHaveBeenCalled();
      const failedCall = mockExecuteRawUnsafe.mock.calls.find(
        (call) => String(call[0]).includes("SET status = $1") && call[1] === "failed",
      );
      expect(failedCall).toBeDefined();
    });
  });

  describe("delivery history", () => {
    it("returns mapped delivery records with pagination", async () => {
      const row = {
        id: "33333333-3333-3333-3333-333333333333",
        endpoint_id: "11111111-1111-1111-1111-111111111111",
        endpoint_url: "https://partner.example.com/hooks/governance",
        event_type: "proposal.executed",
        proposal_id: "prop-1",
        contract_id: "CONTRACT_A",
        status: "delivered",
        attempts: 1,
        max_attempts: 5,
        response_status: 200,
        response_body: "{\"ok\":true}",
        error_message: null,
        created_at: new Date("2026-01-01T00:00:00Z"),
        updated_at: new Date("2026-01-01T00:01:00Z"),
        delivered_at: new Date("2026-01-01T00:01:00Z"),
      };

      mockQueryRawUnsafe
        .mockResolvedValueOnce([row])
        .mockResolvedValueOnce([{ count: 1 }]);

      const history = await service.getDeliveryHistory({
        proposalId: "prop-1",
      });

      expect(history.total).toBe(1);
      expect(history.deliveries[0]).toMatchObject({
        id: row.id,
        endpointId: row.endpoint_id,
        eventType: "proposal.executed",
        status: "delivered",
        responseStatus: 200,
      });
    });

    it("aggregates delivery stats", async () => {
      mockQueryRawUnsafe.mockResolvedValueOnce([
        { status: "delivered", count: 3 },
        { status: "failed", count: 1 },
      ]);

      const stats = await service.getDeliveryStats();
      expect(stats).toEqual({
        pending: 0,
        retrying: 0,
        delivered: 3,
        failed: 1,
        total: 4,
      });
    });
  });

  describe("payload builder", () => {
    it("builds a stable payload with an event id and timestamp", () => {
      const payload = service.buildPayload("proposal.expired", {
        proposalId: "prop-1",
        status: "Queued",
      });
      expect(payload.event).toBe("proposal.expired");
      expect(payload.eventId).toBeTruthy();
      expect(new Date(payload.timestamp).toString()).not.toBe("Invalid Date");
      expect(payload.data.proposalId).toBe("prop-1");
    });
  });
});

describe("GovernanceWebhookEndpoint typing", () => {
  it("exposes the endpoint contract", () => {
    const endpoint: GovernanceWebhookEndpoint = {
      id: "id",
      name: null,
      url: "https://example.com",
      secret: "s",
      events: ["proposal.executed"],
      active: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    expect(endpoint.events).toContain("proposal.executed");
  });
});
