import { Horizon, rpc as SorobanRpc } from "@stellar/stellar-sdk";
import dotenv from "dotenv";
import { logger } from "../utils/logger";
import { getStellarNetwork } from "./stellarNetwork";

dotenv.config();

/**
 * Whether an error from the Horizon SDK or RPC should trigger a failover to the next node.
 * Covers HTTP 5xx responses and common network-level errors.
 */
function isFailoverError(error: unknown): boolean {
  if (error && typeof error === "object") {
    const err = error as Record<string, any>;

    // HTTP 5xx from Horizon or RPC
    const httpStatus: unknown =
      err.response?.status ?? err.status ?? err.statusCode;
    if (typeof httpStatus === "number" && httpStatus >= 500) {
      return true;
    }

    // Network-level errors
    const networkCodes = new Set([
      "ECONNREFUSED",
      "ECONNRESET",
      "ETIMEDOUT",
      "ECONNABORTED",
      "ENETUNREACH",
      "EHOSTUNREACH",
    ]);
    if (typeof err.code === "string" && networkCodes.has(err.code)) {
      return true;
    }

    // SDK timeout messages or RPC errors indicating connection issues
    if (typeof err.message === "string") {
      const msg = err.message.toLowerCase();
      if (
        msg.includes("timeout") ||
        msg.includes("network error") ||
        msg.includes("econnrefused") ||
        msg.includes("fetch failed")
      ) {
        return true;
      }
    }
  }

  return false;
}

/**
 * Builds the ordered list of fallback Horizon URLs for a given network.
 */
function buildHorizonUrls(network: string): string[] {
  const isMainnet = network === "PUBLIC";

  const sdfUrl = isMainnet
    ? "https://horizon.stellar.org"
    : "https://horizon-testnet.stellar.org";

  const publicNodeUrl = isMainnet
    ? "https://horizon.publicnode.org"
    : "https://horizon-testnet.publicnode.org";

  const urls: string[] = [];

  const customUrl = process.env.HORIZON_URL?.trim();
  if (customUrl) {
    urls.push(customUrl);
  }

  urls.push(sdfUrl, publicNodeUrl);

  return urls;
}

/**
 * Builds the ordered list of fallback RPC URLs for a given network.
 */
function buildRpcUrls(network: string): string[] {
  const isMainnet = network === "PUBLIC";

  const sdfUrl = isMainnet
    ? "https://rpc.mainnet.stellar.org"
    : "https://rpc.testnet.stellar.org";

  const urls: string[] = [];

  const customUrl = process.env.RPC_URL?.trim();
  if (customUrl) {
    urls.push(customUrl);
  }

  // Load configurable fallback RPC URLs (comma-separated)
  const customFallbacks = process.env.FALLBACK_RPC_URLS?.trim();
  if (customFallbacks) {
    urls.push(
      ...customFallbacks
        .split(",")
        .map((u) => u.trim())
        .filter(Boolean)
    );
  }

  // Ensure default SDF node is in the list
  if (!urls.includes(sdfUrl)) {
    urls.push(sdfUrl);
  }

  return urls;
}

/**
 * StellarProvider — singleton that manages a pool of Horizon and RPC servers with
 * automatic failover.
 */
class StellarProvider {
  private readonly network: string;
  // Last observed latencies (ms)
  private lastHorizonLatencyMs?: number;
  private lastRpcLatencyMs?: number;
  
  // Horizon properties
  private readonly urls: readonly string[];
  private currentIndex: number = 0;
  private server: Horizon.Server;

  // RPC properties
  private readonly rpcUrls: readonly string[];
  private rpcCurrentIndex: number = 0;
  private rpcServer: SorobanRpc.Server;

  constructor() {
    this.network = getStellarNetwork();

    // Initialize Horizon
    this.urls = buildHorizonUrls(this.network);
    this.server = this.wrapServer(new Horizon.Server(this.urls[0]!));
    logger.info(
      `[StellarProvider] Initialized Horizon with ${this.urls.length} node(s). Primary: ${this.urls[0]!}`,
    );

    // Initialize RPC
    this.rpcUrls = buildRpcUrls(this.network);
    this.rpcServer = this.wrapServer(
      new SorobanRpc.Server(this.rpcUrls[0]!, {
        allowHttp: this.network === "TESTNET",
      }),
      true,
    );
    logger.info(
      `[StellarProvider] Initialized RPC with ${this.rpcUrls.length} node(s). Primary: ${this.rpcUrls[0]!}`,
    );
  }

  /**
   * Wrap a server instance (Horizon or RPC) with a Proxy that measures latency
   * and reports failures back into the provider so automatic failover can occur.
   */
  private wrapServer<T extends object>(server: T, isRpc = false): T {
    const self = this;

    return new Proxy(server as any, {
      get(target: any, prop: PropertyKey, receiver: any) {
        const orig = Reflect.get(target, prop, receiver);

        if (typeof orig !== "function") return orig;

        return function wrapped(...args: any[]) {
          const start = Date.now();
          try {
            const res = orig.apply(target, args);
            if (res && typeof res.then === "function") {
              return res
                .then((r: any) => {
                  const latency = Date.now() - start;
                  if (isRpc) self.lastRpcLatencyMs = latency;
                  else self.lastHorizonLatencyMs = latency;
                  logger.networkInfo(
                    `[StellarProvider] ${isRpc ? "RPC" : "Horizon"} ${String(prop)} latency=${latency}ms`,
                    {
                      latency,
                      url: isRpc ? self.getCurrentRpcUrl() : self.getCurrentUrl(),
                    },
                  );
                  return r;
                })
                .catch((err: any) => {
                  const latency = Date.now() - start;
                  if (isRpc) self.lastRpcLatencyMs = latency;
                  else self.lastHorizonLatencyMs = latency;
                  // Report failure and include latency so logs contain timing metrics
                  if (isRpc) self.reportRpcFailure(err, latency);
                  else self.reportFailure(err, latency);
                  throw err;
                });
            }

            const latency = Date.now() - start;
            if (isRpc) self.lastRpcLatencyMs = latency;
            else self.lastHorizonLatencyMs = latency;
            logger.networkInfo(
              `[StellarProvider] ${isRpc ? "RPC" : "Horizon"} ${String(prop)} latency=${latency}ms`,
              { latency, url: isRpc ? self.getCurrentRpcUrl() : self.getCurrentUrl() },
            );
            return res;
          } catch (err) {
            const latency = Date.now() - start;
            if (isRpc) self.lastRpcLatencyMs = latency;
            else self.lastHorizonLatencyMs = latency;
            if (isRpc) self.reportRpcFailure(err, latency);
            else self.reportFailure(err, latency);
            throw err;
          }
        };
      },
    }) as T;
  }

  // ==========================================
  // Horizon methods
  // ==========================================
  getServer(): Horizon.Server {
    return this.server;
  }

  getCurrentUrl(): string {
    return this.urls[this.currentIndex]!;
  }

  reportFailure(error: unknown, latencyMs?: number): boolean {
    if (!isFailoverError(error)) {
      return false;
    }

    const failedUrl = this.urls[this.currentIndex]!;
    const nextIndex = (this.currentIndex + 1) % this.urls.length;

    if (nextIndex === this.currentIndex) {
      logger.networkError(
        `[StellarProvider] Horizon Node ${failedUrl} failed and no fallback is available.`,
      );
      return false;
    }

    this.currentIndex = nextIndex;
    this.server = this.wrapServer(new Horizon.Server(this.urls[this.currentIndex]!));

    logger.warn(
      `[StellarProvider] ⚠️ Horizon Node "${failedUrl}" returned an error. ` +
        `Failing over to "${this.urls[this.currentIndex]!}" ` +
        `(node ${this.currentIndex + 1}/${this.urls.length}).`,
      { isNetwork: true, failedUrl, latencyMs }
    );

    return true;
  }

  // ==========================================
  // RPC methods
  // ==========================================
  getRpcServer(): SorobanRpc.Server {
    return this.rpcServer;
  }

  getCurrentRpcUrl(): string {
    return this.rpcUrls[this.rpcCurrentIndex]!;
  }

  reportRpcFailure(error: unknown, latencyMs?: number): boolean {
    if (!isFailoverError(error)) {
      return false;
    }

    const failedUrl = this.rpcUrls[this.rpcCurrentIndex]!;
    const nextIndex = (this.rpcCurrentIndex + 1) % this.rpcUrls.length;

    if (nextIndex === this.rpcCurrentIndex) {
      logger.networkError(
        `[StellarProvider] RPC Node ${failedUrl} failed and no fallback is available.`,
      );
      return false;
    }

    this.rpcCurrentIndex = nextIndex;
    this.rpcServer = this.wrapServer(
      new SorobanRpc.Server(this.rpcUrls[this.rpcCurrentIndex]!, {
        allowHttp: this.network === "TESTNET",
      }),
      true,
    );

    logger.warn(
      `[StellarProvider] ⚠️ RPC Node "${failedUrl}" returned an error. ` +
        `Failing over to "${this.rpcUrls[this.rpcCurrentIndex]!}" ` +
        `(node ${this.rpcCurrentIndex + 1}/${this.rpcUrls.length}).`,
      { isNetwork: true, failedUrl, latencyMs }
    );

    return true;
  }
}

const stellarProvider = new StellarProvider();
export default stellarProvider;
