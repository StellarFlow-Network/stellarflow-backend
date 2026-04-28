import { Horizon } from "@stellar/stellar-sdk";
import dotenv from "dotenv";
import { Horizon } from "stellar-sdk";

dotenv.config();

/**
 * Whether an error from the Horizon SDK should trigger a failover to the next node.
 * Covers HTTP 5xx responses and common network-level errors.
 */
function isFailoverError(error: unknown): boolean {
  if (error && typeof error === "object") {
    const err = error as Record<string, any>;

    // HTTP 5xx from Horizon
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
 * StellarProvider — singleton that manages a pool of Horizon servers with
 * automatic failover.
 */
class StellarProvider {
  private readonly urls: readonly string[];
  private currentIndex: number = 0;
  private server: Horizon.Server;

  constructor() {
    const network = process.env.STELLAR_NETWORK || "TESTNET";
    this.urls = buildHorizonUrls(network);
    this.server = new Horizon.Server(this.urls[0]!);
    console.info(
      `[StellarProvider] Initialized with ${this.urls.length} node(s). Primary: ${this.urls[0]!}`,
    );
  }

  getServer(): Horizon.Server {
    return this.server;
  }

  getCurrentUrl(): string {
    return this.urls[this.currentIndex]!;
  }

  reportFailure(error: unknown): boolean {
    if (!isFailoverError(error)) {
      return false;
    }

    const failedUrl = this.urls[this.currentIndex]!;
    const nextIndex = (this.currentIndex + 1) % this.urls.length;

    if (nextIndex === this.currentIndex) {
      console.error(
        `[StellarProvider] Node ${failedUrl} failed and no fallback is available.`,
      );
      return false;
    }

    this.currentIndex = nextIndex;
    this.server = new Horizon.Server(this.urls[this.currentIndex]!);

    console.warn(
      `[StellarProvider] ⚠️ Node "${failedUrl}" returned an error. ` +
        `Failing over to "${this.urls[this.currentIndex]!}" ` +
        `(node ${this.currentIndex + 1}/${this.urls.length}).`,
    );

    return true;
  }
}

const stellarProvider = new StellarProvider();
export default stellarProvider;
export default stellarProvider;
