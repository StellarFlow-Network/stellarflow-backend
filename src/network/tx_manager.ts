import { RpcLoadBalancer } from "../lib/rpcLoadBalancer";
import {
  SorobanInvokerEnvelope,
  SorobanInvokerValidation,
  validateSorobanInvoker,
} from "../middleware/sorobanAuthInvoker";

export interface TransactionSubmitRequest {
  /** Base64-encoded transaction envelope to submit. */
  transactionXdr: string;
  /** Soroban invoker authorization envelopes to validate before submission. */
  authorizations?: readonly SorobanInvokerEnvelope[];
}

export type TransactionSrcPreflight =
  | { ok: true; addresses: string[] }
  | { ok: false; reason: string; failedAt?: number };

export interface TransactionSubmitResult {
  submitted: boolean;
  endpoint?: string;
  preflight: TransactionSrcPreflight;
}

export interface TxManagerOptions {
  /** Transport used to POST the transaction to an RPC endpoint. */
  submitTransport: (url: string, body: unknown) => Promise<unknown>;
  /** Optional clock injection for deterministic testing. */
  now?: () => number;
}

/**
 * Pre-flights Soroban invoker authorization envelopes and only queues the
 * transaction for RPC submission when every credential is valid. This avoids wasted
 * fees from on-chain invoker authorization reverts.
 */
export class TransactionManager {
  private readonly balancer: RpcLoadBalancer;
  private readonly options: TxManagerOptions;

  constructor(balancer: RpcLoadBalancer, options: TxManagerOptions) {
    this.balancer = balancer;
    this.options = options;
  }

  /** Validates all authorization envelopes without touching the network. */
  preflightAuthorizations(
    authorizations: readonly SorobanInvokerEnvelope[],
  ): TransactionSrcPreflight {
    const addresses: string[] = [];
    for (let i = 0; i < authorizations.length; i++) {
      const result: SorobanInvokerValidation = validateSorobanInvoker(authorizations[i]);
      if (!result.valid) {
        return { ok: false, reason: `${result.reason} (authorization ${i})`, failedAt: i };
      }
      addresses.push(result.address);
    }
    return { ok: true, addresses };
  }

  /**
   * Runs pre-flight authorization checks and, if they pass, submits the transaction
   * to the next healthy RPC endpoint. Invalid envelopes never reach the RPC.
   */
  async submit(request: TransactionSubmitRequest): Promise<TransactionSubmitResult> {
    const preflight = this.preflightAuthorizations(request.authorizations ?? []);
    if (!preflight.ok) {
      return { submitted: false, preflight };
    }

    const now = this.options.now ?? Date.now;
    const endpoint = this.balancer.next(now());
    if (!endpoint) {
      return {
        submitted: false,
        preflight: { ok: false, reason: "no RPC endpoint available" },
      };
    }

    const started = now();
    try {
      await this.options.submitTransport(endpoint.url, {
        transactionXdr: request.transactionXdr,
      });
      this.balancer.recordSuccess(endpoint.url, now() - started);
      return { submitted: true, endpoint: endpoint.url, preflight };
    } catch {
      this.balancer.recordFailure(endpoint.url, now() - started, now());
      return {
        submitted: false,
        endpoint: endpoint.url,
        preflight: { ok: false, reason: "RPC submission failed" },
      };
    }
  }
}
