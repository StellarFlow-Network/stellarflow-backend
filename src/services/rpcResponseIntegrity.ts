import { rpc as SorobanRpc } from "@stellar/stellar-sdk";
import { logger } from "../utils/logger";
import prisma from "../lib/prisma";
import crypto from "crypto";

export interface RpcEndpoint {
  url: string;
  name: string;
}

export interface RpcRequestPayload {
  method: string;
  params: unknown[];
  id: string | number;
}

export interface RpcResponse<T = unknown> {
  jsonrpc: string;
  id: string | number;
  result?: T;
  error?: {
    code: number;
    message: string;
    data?: unknown;
  };
}

export interface ValidationResult<T = unknown> {
  isValid: boolean;
  consensusResult?: T | undefined;
  responses: EndpointResponse<T>[];
  divergenceDetails?: DivergenceDetails | undefined;
}

export interface EndpointResponse<T = unknown> {
  endpoint: RpcEndpoint;
  response: RpcResponse<T>;
  latencyMs: number;
  success: boolean;
  stateHash?: string | undefined;
}

export interface DivergenceDetails {
  method: string;
  params: unknown[];
  endpointHashes: Record<string, string>;
  majorityHash?: string | undefined;
  divergingEndpoints: string[];
  timestamp: string;
}

export interface RpcStateDivergenceLog {
  id: string;
  method: string;
  params: unknown[];
  endpointHashes: Record<string, string>;
  majorityHash?: string;
  divergingEndpoints: string[];
  timestamp: Date;
  resolved: boolean;
  resolutionNotes?: string;
}

const DEFAULT_RPC_ENDPOINTS: RpcEndpoint[] = [
  { url: process.env.RPC_URL_1 || "https://rpc.mainnet.stellar.org", name: "SDF Mainnet" },
  { url: process.env.RPC_URL_2 || "https://rpc.stellar.org", name: "Stellar.org" },
  { url: process.env.RPC_URL_3 || "https://soroban-rpc.mainnet.stellar.gateway.fm", name: "Gateway.fm" },
];

const CRITICAL_METHODS = new Set([
  "getContractData",
  "getContractEvents",
  "getLatestLedger",
  "getLedgerEntries",
  "simulateTransaction",
  "getNetwork",
]);

export class RpcResponseIntegrityMiddleware {
  private endpoints: RpcEndpoint[];
  private timeoutMs: number;
  private criticalMethods: Set<string>;

  constructor(
    endpoints: RpcEndpoint[] = DEFAULT_RPC_ENDPOINTS,
    timeoutMs: number = 5000,
    criticalMethods?: string[],
  ) {
    this.endpoints = endpoints.slice(0, 3);
    this.timeoutMs = timeoutMs;
    this.criticalMethods = new Set(criticalMethods || [...CRITICAL_METHODS]);
  }

  async validateCriticalQuery<T = unknown>(
    method: string,
    params: unknown[],
  ): Promise<ValidationResult<T>> {
    if (!this.criticalMethods.has(method)) {
      return this.singleNodeQuery<T>(method, params);
    }

    const requestId = crypto.randomUUID();
    const payload: RpcRequestPayload = {
      method,
      params,
      id: requestId,
    };

    const responses = await this.queryAllEndpoints<T>(payload);
    const validResponses = responses.filter((r) => r.success);

    if (validResponses.length === 0) {
      throw new Error(`All RPC endpoints failed for method: ${method}`);
    }

    const responsesWithHash = validResponses.map((r) => ({
      ...r,
      stateHash: this.computeStateHash(r.response.result),
    }));

    const divergence = this.detectDivergence(responsesWithHash, method, params);

    if (divergence) {
      await this.logDivergence(divergence);
      throw new RpcDivergenceError(
        `RPC state divergence detected for method: ${method}`,
        divergence,
      );
    }

    const consensusResult = this.extractConsensusResult(responsesWithHash);

    return {
      isValid: true,
      consensusResult,
      responses: responsesWithHash,
    };
  }

  async singleNodeQuery<T = unknown>(
    method: string,
    params: unknown[],
  ): Promise<ValidationResult<T>> {
    if (this.endpoints.length === 0) {
      throw new Error("No RPC endpoints configured");
    }
    const endpoint = this.endpoints[0]!;
    const client = new SorobanRpc.Server(endpoint.url, {
      allowHttp: endpoint.url.includes("testnet") || endpoint.url.includes("localhost"),
    });

    const startTime = Date.now();
    try {
      const result = await this.executeRpcMethod<T>(client, method, params);
      const latencyMs = Date.now() - startTime;

      return {
        isValid: true,
        consensusResult: result,
        responses: [
          {
            endpoint,
            response: { jsonrpc: "2.0", id: 1, result },
            latencyMs,
            success: true,
            stateHash: this.computeStateHash(result),
          },
        ],
      };
    } catch (error) {
      const latencyMs = Date.now() - startTime;
      return {
        isValid: false,
        responses: [
          {
            endpoint,
            response: {
              jsonrpc: "2.0",
              id: 1,
              error: { code: -32603, message: String(error) },
            },
            latencyMs,
            success: false,
          },
        ],
      };
    }
  }

  private async queryAllEndpoints<T>(payload: RpcRequestPayload): Promise<EndpointResponse<T>[]> {
    const promises = this.endpoints.map((endpoint) =>
      this.queryEndpoint<T>(endpoint, payload),
    );

    return Promise.allSettled(promises).then((results) =>
      results.map((result, index) => {
        if (result.status === "fulfilled") {
          return result.value;
        }
        const endpoint = this.endpoints[index]!;
        return {
          endpoint,
          response: {
            jsonrpc: "2.0",
            id: payload.id,
            error: { code: -32603, message: String(result.reason) },
          },
          latencyMs: this.timeoutMs,
          success: false,
        };
      }),
    );
  }

  private async queryEndpoint<T>(
    endpoint: RpcEndpoint,
    payload: RpcRequestPayload,
  ): Promise<EndpointResponse<T>> {
    const client = new SorobanRpc.Server(endpoint.url, {
      allowHttp: endpoint.url.includes("testnet") || endpoint.url.includes("localhost"),
    });

    const startTime = Date.now();

    try {
      const result = await Promise.race([
        this.executeRpcMethod<T>(client, payload.method, payload.params),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("Timeout")), this.timeoutMs),
        ),
      ]);

      const latencyMs = Date.now() - startTime;

      return {
        endpoint,
        response: { jsonrpc: "2.0", id: payload.id, result },
        latencyMs,
        success: true,
        stateHash: this.computeStateHash(result),
      };
    } catch (error) {
      const latencyMs = Date.now() - startTime;
      return {
        endpoint,
        response: {
          jsonrpc: "2.0",
          id: payload.id,
          error: { code: -32603, message: String(error) },
        },
        latencyMs,
        success: false,
      };
    }
  }

  private async executeRpcMethod<T>(
    client: SorobanRpc.Server,
    method: string,
    params: unknown[],
  ): Promise<T> {
    const methodFn = (client as any)[method];
    if (typeof methodFn !== "function") {
      throw new Error(`Method ${method} not found on RPC client`);
    }
    return methodFn.apply(client, params);
  }

  private computeStateHash(data: unknown): string {
    const serialized = JSON.stringify(data, Object.keys(data as object).sort());
    return crypto.createHash("sha256").update(serialized).digest("hex");
  }

  private detectDivergence<T>(
    responses: EndpointResponse<T>[],
    method: string,
    params: unknown[],
  ): DivergenceDetails | null {
    const hashGroups = new Map<string, EndpointResponse<T>[]>();

    for (const response of responses) {
      if (!response.stateHash) continue;
      const group = hashGroups.get(response.stateHash) || [];
      group.push(response);
      hashGroups.set(response.stateHash, group);
    }

    if (hashGroups.size <= 1) {
      return null;
    }

    let majorityHash: string | undefined;
    let maxCount = 0;
    for (const [hash, group] of hashGroups) {
      if (group.length > maxCount) {
        maxCount = group.length;
        majorityHash = hash;
      }
    }

    const divergingEndpoints = responses
      .filter((r) => r.stateHash && r.stateHash !== majorityHash)
      .map((r) => r.endpoint.name);

    const endpointHashes: Record<string, string> = {};
    for (const response of responses) {
      if (response.stateHash) {
        endpointHashes[response.endpoint.name] = response.stateHash;
      }
    }

    return {
      method,
      params,
      endpointHashes,
      majorityHash,
      divergingEndpoints,
      timestamp: new Date().toISOString(),
    };
  }

  private extractConsensusResult<T>(responses: EndpointResponse<T>[]): T | undefined {
    const validResponses = responses.filter((r) => r.success && r.stateHash);
    if (validResponses.length === 0) return undefined;

    const hashGroups = new Map<string, EndpointResponse<T>[]>();
    for (const response of validResponses) {
      if (!response.stateHash) continue;
      const group = hashGroups.get(response.stateHash) || [];
      group.push(response);
      hashGroups.set(response.stateHash, group);
    }

    let majorityGroup: EndpointResponse<T>[] = [];
    for (const group of hashGroups.values()) {
      if (group.length > majorityGroup.length) {
        majorityGroup = group;
      }
    }

    return majorityGroup[0]?.response.result;
  }

  private async logDivergence(divergence: DivergenceDetails): Promise<void> {
    try {
      await prisma.rpcStateDivergence.create({
        data: {
          id: crypto.randomUUID(),
          method: divergence.method,
          params: divergence.params as any,
          endpointHashes: divergence.endpointHashes as any,
          majorityHash: divergence.majorityHash,
          divergingEndpoints: divergence.divergingEndpoints,
          timestamp: new Date(divergence.timestamp),
          resolved: false,
        },
      });

      logger.error(
        "[RpcIntegrity] 🚨 RPC STATE DIVERGENCE DETECTED",
        {
          method: divergence.method,
          divergingEndpoints: divergence.divergingEndpoints,
          endpointHashes: divergence.endpointHashes,
          majorityHash: divergence.majorityHash,
        },
      );
    } catch (error) {
      logger.error("[RpcIntegrity] Failed to log divergence:", error);
    }
  }

  async getDivergenceLogs(
    limit: number = 100,
    resolved?: boolean,
  ): Promise<RpcStateDivergenceLog[]> {
    return prisma.rpcStateDivergence.findMany({
      where: resolved !== undefined ? { resolved } : undefined,
      orderBy: { timestamp: "desc" },
      take: limit,
    });
  }

  async resolveDivergence(id: string, resolutionNotes: string): Promise<void> {
    await prisma.rpcStateDivergence.update({
      where: { id },
      data: { resolved: true, resolutionNotes },
    });
  }

  addEndpoint(endpoint: RpcEndpoint): void {
    if (this.endpoints.length < 3) {
      this.endpoints.push(endpoint);
    }
  }

  removeEndpoint(url: string): void {
    this.endpoints = this.endpoints.filter((e) => e.url !== url);
  }

  getEndpoints(): RpcEndpoint[] {
    return [...this.endpoints];
  }

  isCriticalMethod(method: string): boolean {
    return this.criticalMethods.has(method);
  }

  addCriticalMethod(method: string): void {
    this.criticalMethods.add(method);
  }

  removeCriticalMethod(method: string): void {
    this.criticalMethods.delete(method);
  }
}

export class RpcDivergenceError extends Error {
  public readonly divergence: DivergenceDetails;

  constructor(message: string, divergence: DivergenceDetails) {
    super(message);
    this.name = "RpcDivergenceError";
    this.divergence = divergence;
  }
}

export const rpcResponseIntegrityMiddleware = new RpcResponseIntegrityMiddleware();