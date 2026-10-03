import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  RpcResponseIntegrityMiddleware,
  RpcDivergenceError,
} from "../src/services/rpcResponseIntegrity.js";

vi.mock("../lib/prisma.js", () => ({
  default: {
    rpcStateDivergence: {
      create: vi.fn(),
      findMany: vi.fn(),
      update: vi.fn(),
    },
  },
}));

vi.mock("../utils/logger.js", () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

import prisma from "../lib/prisma.js";

describe("RpcResponseIntegrityMiddleware", () => {
  let middleware: RpcResponseIntegrityMiddleware;

  beforeEach(() => {
    vi.clearAllMocks();
    middleware = new RpcResponseIntegrityMiddleware(
      [
        { url: "https://rpc1.test", name: "Node1" },
        { url: "https://rpc2.test", name: "Node2" },
        { url: "https://rpc3.test", name: "Node3" },
      ],
      1000,
      ["getLatestLedger", "getContractData"],
    );
  });

  afterEach(() => {
    vi.resetAllMocks();
  });

  describe("computeStateHash", () => {
    it("should compute consistent hashes for identical data", () => {
      const data = { ledger: 123, hash: "abc" };
      const hash1 = (middleware as any).computeStateHash(data);
      const hash2 = (middleware as any).computeStateHash(data);
      expect(hash1).toBe(hash2);
    });

    it("should compute different hashes for different data", () => {
      const hash1 = (middleware as any).computeStateHash({ ledger: 123 });
      const hash2 = (middleware as any).computeStateHash({ ledger: 124 });
      expect(hash1).not.toBe(hash2);
    });

    it("should handle null and undefined", () => {
      const hash1 = (middleware as any).computeStateHash(null);
      const hash2 = (middleware as any).computeStateHash(undefined);
      expect(hash1).toBeDefined();
      expect(hash2).toBeDefined();
    });

    it("should handle arrays consistently", () => {
      const hash1 = (middleware as any).computeStateHash([1, 2, 3]);
      const hash2 = (middleware as any).computeStateHash([1, 2, 3]);
      expect(hash1).toBe(hash2);
    });
  });

  describe("isCriticalMethod", () => {
    it("should return true for configured critical methods", () => {
      expect(middleware.isCriticalMethod("getLatestLedger")).toBe(true);
      expect(middleware.isCriticalMethod("getContractData")).toBe(true);
    });

    it("should return false for non-critical methods", () => {
      expect(middleware.isCriticalMethod("getHealth")).toBe(false);
      expect(middleware.isCriticalMethod("unknownMethod")).toBe(false);
    });
  });

  describe("addCriticalMethod / removeCriticalMethod", () => {
    it("should allow adding and removing critical methods", () => {
      expect(middleware.isCriticalMethod("customMethod")).toBe(false);
      middleware.addCriticalMethod("customMethod");
      expect(middleware.isCriticalMethod("customMethod")).toBe(true);
      middleware.removeCriticalMethod("customMethod");
      expect(middleware.isCriticalMethod("customMethod")).toBe(false);
    });
  });

  describe("detectDivergence", () => {
    it("should return null when all responses match", () => {
      const responses = [
        {
          endpoint: { url: "https://rpc1.test", name: "Node1" },
          response: { jsonrpc: "2.0", id: 1, result: { ledger: 123 } },
          latencyMs: 100,
          success: true,
          stateHash: "abc123",
        },
        {
          endpoint: { url: "https://rpc2.test", name: "Node2" },
          response: { jsonrpc: "2.0", id: 1, result: { ledger: 123 } },
          latencyMs: 100,
          success: true,
          stateHash: "abc123",
        },
      ];

      const divergence = (middleware as any).detectDivergence(
        responses,
        "getLatestLedger",
        [],
      );
      expect(divergence).toBeNull();
    });

    it("should detect divergence when hashes differ", () => {
      const responses = [
        {
          endpoint: { url: "https://rpc1.test", name: "Node1" },
          response: { jsonrpc: "2.0", id: 1, result: { ledger: 123 } },
          latencyMs: 100,
          success: true,
          stateHash: "abc123",
        },
        {
          endpoint: { url: "https://rpc2.test", name: "Node2" },
          response: { jsonrpc: "2.0", id: 1, result: { ledger: 124 } },
          latencyMs: 100,
          success: true,
          stateHash: "def456",
        },
        {
          endpoint: { url: "https://rpc3.test", name: "Node3" },
          response: { jsonrpc: "2.0", id: 1, result: { ledger: 123 } },
          latencyMs: 100,
          success: true,
          stateHash: "abc123",
        },
      ];

      const divergence = (middleware as any).detectDivergence(
        responses,
        "getLatestLedger",
        [],
      );

      expect(divergence).not.toBeNull();
      expect(divergence!.method).toBe("getLatestLedger");
      expect(divergence!.majorityHash).toBe("abc123");
      expect(divergence!.divergingEndpoints).toContain("Node2");
      expect(divergence!.endpointHashes["Node1"]).toBe("abc123");
      expect(divergence!.endpointHashes["Node2"]).toBe("def456");
    });

    it("should handle case with no majority (all different)", () => {
      const responses = [
        {
          endpoint: { url: "https://rpc1.test", name: "Node1" },
          response: { jsonrpc: "2.0", id: 1, result: { ledger: 123 } },
          latencyMs: 100,
          success: true,
          stateHash: "hash1",
        },
        {
          endpoint: { url: "https://rpc2.test", name: "Node2" },
          response: { jsonrpc: "2.0", id: 1, result: { ledger: 124 } },
          latencyMs: 100,
          success: true,
          stateHash: "hash2",
        },
        {
          endpoint: { url: "https://rpc3.test", name: "Node3" },
          response: { jsonrpc: "2.0", id: 1, result: { ledger: 125 } },
          latencyMs: 100,
          success: true,
          stateHash: "hash3",
        },
      ];

      const divergence = (middleware as any).detectDivergence(
        responses,
        "getLatestLedger",
        [],
      );

      expect(divergence).not.toBeNull();
      expect(divergence!.majorityHash).toBeDefined();
      expect(divergence!.divergingEndpoints.length).toBe(2);
    });
  });

  describe("extractConsensusResult", () => {
    it("should return result from majority group", () => {
      const responses = [
        {
          endpoint: { url: "https://rpc1.test", name: "Node1" },
          response: { jsonrpc: "2.0", id: 1, result: { ledger: 123 } },
          latencyMs: 100,
          success: true,
          stateHash: "abc123",
        },
        {
          endpoint: { url: "https://rpc2.test", name: "Node2" },
          response: { jsonrpc: "2.0", id: 1, result: { ledger: 123 } },
          latencyMs: 100,
          success: true,
          stateHash: "abc123",
        },
        {
          endpoint: { url: "https://rpc3.test", name: "Node3" },
          response: { jsonrpc: "2.0", id: 1, result: { ledger: 124 } },
          latencyMs: 100,
          success: true,
          stateHash: "def456",
        },
      ];

      const consensus = (middleware as any).extractConsensusResult(responses);
      expect(consensus).toEqual({ ledger: 123 });
    });

    it("should return undefined when no valid responses", () => {
      const responses = [
        {
          endpoint: { url: "https://rpc1.test", name: "Node1" },
          response: { jsonrpc: "2.0", id: 1, error: { code: -32603, message: "Error" } },
          latencyMs: 100,
          success: false,
        },
      ];

      const consensus = (middleware as any).extractConsensusResult(responses);
      expect(consensus).toBeUndefined();
    });
  });

  describe("logDivergence", () => {
    it("should log divergence to database", async () => {
      const divergence = {
        method: "getLatestLedger",
        params: [],
        endpointHashes: { Node1: "abc123", Node2: "def456" },
        majorityHash: "abc123",
        divergingEndpoints: ["Node2"],
        timestamp: new Date().toISOString(),
      };

      await (middleware as any).logDivergence(divergence);

      expect(prisma.rpcStateDivergence.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            method: "getLatestLedger",
            divergingEndpoints: ["Node2"],
            majorityHash: "abc123",
            resolved: false,
          }),
        }),
      );
    });
  });

  describe("getDivergenceLogs", () => {
    it("should fetch divergence logs with filters", async () => {
      const mockLogs = [
        { id: "1", method: "getLatestLedger", resolved: false, timestamp: new Date() },
        { id: "2", method: "getContractData", resolved: true, timestamp: new Date() },
      ];
      (prisma.rpcStateDivergence.findMany as vi.Mock).mockResolvedValue(mockLogs);

      const logs = await middleware.getDivergenceLogs(10, false);
      expect(logs).toHaveLength(2);
      expect(prisma.rpcStateDivergence.findMany).toHaveBeenCalledWith({
        where: { resolved: false },
        orderBy: { timestamp: "desc" },
        take: 10,
      });
    });
  });

  describe("resolveDivergence", () => {
    it("should update divergence as resolved", async () => {
      await middleware.resolveDivergence("div-123", "Manual review completed");

      expect(prisma.rpcStateDivergence.update).toHaveBeenCalledWith({
        where: { id: "div-123" },
        data: { resolved: true, resolutionNotes: "Manual review completed" },
      });
    });
  });

  describe("endpoint management", () => {
    it("should add endpoint when under limit", () => {
      const newMiddleware = new RpcResponseIntegrityMiddleware(
        [{ url: "https://rpc1.test", name: "Node1" }],
        1000,
      );
      newMiddleware.addEndpoint({ url: "https://rpc2.test", name: "Node2" });
      newMiddleware.addEndpoint({ url: "https://rpc3.test", name: "Node3" });
      expect(newMiddleware.getEndpoints()).toHaveLength(3);
    });

    it("should not add endpoint when at limit", () => {
      const newMiddleware = new RpcResponseIntegrityMiddleware(
        [
          { url: "https://rpc1.test", name: "Node1" },
          { url: "https://rpc2.test", name: "Node2" },
          { url: "https://rpc3.test", name: "Node3" },
        ],
        1000,
      );
      newMiddleware.addEndpoint({ url: "https://rpc4.test", name: "Node4" });
      expect(newMiddleware.getEndpoints()).toHaveLength(3);
    });

    it("should remove endpoint by URL", () => {
      middleware.removeEndpoint("https://rpc1.test");
      expect(middleware.getEndpoints()).toHaveLength(2);
      expect(middleware.getEndpoints().find((e) => e.url === "https://rpc1.test")).toBeUndefined();
    });
  });

  describe("RpcDivergenceError", () => {
    it("should create error with divergence details", () => {
      const divergence = {
        method: "getLatestLedger",
        params: [],
        endpointHashes: {},
        majorityHash: "abc123",
        divergingEndpoints: ["Node2"],
        timestamp: new Date().toISOString(),
      };

      const error = new RpcDivergenceError("Divergence detected", divergence);
      expect(error.message).toBe("Divergence detected");
      expect(error.name).toBe("RpcDivergenceError");
      expect(error.divergence).toBe(divergence);
    });
  });
});