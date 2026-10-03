import stellarProvider from "../lib/stellarProvider";
import { rpcResponseIntegrityMiddleware, ValidationResult } from "./rpcResponseIntegrity";
import { logger } from "../utils/logger";

const CRITICAL_RPC_METHODS = [
  "getContractData",
  "getContractEvents",
  "getLatestLedger",
  "getLedgerEntries",
  "simulateTransaction",
  "getNetwork",
];

export class IntegrityCheckedRpcClient {
  private middleware = rpcResponseIntegrityMiddleware;

  async call<T = unknown>(method: string, params: unknown[]): Promise<T> {
    const isCritical = CRITICAL_RPC_METHODS.includes(method);

    if (!isCritical) {
      return this.singleNodeCall<T>(method, params);
    }

    try {
      const result = await this.middleware.validateCriticalQuery<T>(method, params);
      if (!result.isValid || result.consensusResult === undefined) {
        throw new Error(`Integrity check failed for ${method}: no consensus reached`);
      }
      return result.consensusResult;
    } catch (error) {
      if (error instanceof Error && error.name === "RpcDivergenceError") {
        logger.error(
          `[IntegrityRpc] Divergence detected for ${method}, falling back to primary node`,
          { divergence: (error as any).divergence },
        );
      }
      return this.singleNodeCall<T>(method, params);
    }
  }

  private async singleNodeCall<T>(method: string, params: unknown[]): Promise<T> {
    const rpc = stellarProvider.getRpcServer();
    const methodFn = (rpc as any)[method];

    if (typeof methodFn !== "function") {
      throw new Error(`Method ${method} not found on RPC client`);
    }

    try {
      return await methodFn.apply(rpc, params);
    } catch (error) {
      if (stellarProvider.reportRpcFailure(error)) {
        return this.singleNodeCall<T>(method, params);
      }
      throw error;
    }
  }

  async validateQuery<T = unknown>(method: string, params: unknown[]): Promise<ValidationResult<T>> {
    return this.middleware.validateCriticalQuery<T>(method, params);
  }

  getMiddleware() {
    return this.middleware;
  }
}

export const integrityCheckedRpcClient = new IntegrityCheckedRpcClient();