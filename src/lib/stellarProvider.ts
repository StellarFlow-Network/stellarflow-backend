import { Horizon } from "@stellar/stellar-sdk";

/**
 * Whether an error from the Horizon SDK should trigger a failover to the next node.
 * Covers HTTP 5xx responses and common network-level errors.
 */
function isFailoverError(error: unknown): boolean {
  if (error && typeof error === "object") {
    const err = error as Record<string, any>;

    // HTTP 5xx from Horizon (e.g. { response: { status: 500 } })
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

    // SDK timeout messages
    if (typeof err.message === "string" && err.message.includes("timeout")) {
      return true;
    }
  }

  return false;
}

/**
 * Builds the ordered list of fallback Horizon URLs for a given network.
 *
 * Priority:
 *  1. HORIZON_URL env var (private/custom node)
 *  2. SDF public endpoint
 *  3. Public Node endpoint
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

  // Insert the private node first if configured
  const customUrl = process.env.HORIZON_URL?.trim();
  if (customUrl) {
    urls.push(customUrl);
  }

  urls.push(sdfUrl, publicNodeUrl);

  return urls;
}

/**
 * StellarProvider — singleton that manages a pool of Horizon servers with
 * automatic failover.
 *
 * Usage:
 *   import stellarProvider from "../lib/stellarProvider";
 *   const server = stellarProvider.getServer();
 *   // ...on error:
 *   stellarProvider.reportFailure(error);
 *   const server = stellarProvider.getServer(); // now points to next node
 */
class StellarProvider {
  private readonly urls: readonly string[];
  private currentIndex: number = 0;
  private server: Horizon.Server;

  constructor() {
    const network = process.env.STELLAR_NETWORK || "TESTNET";
    this.urls = buildHorizonUrls(network);
    // urls always has at least one entry (the SDF default), so the assertion is safe
    this.server = new Horizon.Server(this.urls[0]!);
    console.info(
      `[StellarProvider] Initialized with ${this.urls.length} node(s). Primary: ${this.urls[0]!}`,
    );
  }

  /**
   * Returns the currently active Horizon server instance.
   */
  getServer(): Horizon.Server {
    return this.server;
  }

  /**
   * Returns the URL of the currently active node.
   */
  getCurrentUrl(): string {
    return this.urls[this.currentIndex]!;
  }

  /**
   * Inspect an error. If it represents a Horizon/network failure, advance to
   * the next node in the pool and log the failover.
   *
   * @returns `true` if a failover occurred, `false` if the error did not
   *          warrant a switch.
   */
  reportFailure(error: unknown): boolean {
    if (!isFailoverError(error)) {
      return false;
    }

    // currentIndex is always in-bounds; non-null assertions are safe here
    const failedUrl = this.urls[this.currentIndex]!;
    const nextIndex = (this.currentIndex + 1) % this.urls.length;

    if (nextIndex === this.currentIndex) {
      // Only one node configured — nothing to fail over to
      console.error(
        `[StellarProvider] Node ${failedUrl} failed and no fallback is available.`,
      );
      return false;
    }

    this.currentIndex = nextIndex;
    this.server = new Horizon.Server(this.urls[this.currentIndex]!);

    console.warn(
      `[StellarProvider] ⚠️  Node "${failedUrl}" returned an error. ` +
        `Failing over to "${this.urls[this.currentIndex]!}" ` +
        `(node ${this.currentIndex + 1}/${this.urls.length}).`,
    );

    return true;
  }
}

// Export as a module-level singleton so all services share the same instance
// and failover state is consistent across the application.
const stellarProvider = new StellarProvider();
export default stellarProvider;
