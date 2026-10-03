/**
 * IPFS client
 *
 * Publishes immutable content to IPFS through the Kubo HTTP RPC API
 * (`/api/v0/add`) and builds public gateway links for verification.
 *
 * The Kubo API is a stable, well documented HTTP contract, so the client is
 * implemented on top of the built-in `fetch` and adds no dependency.
 *
 * Configuration:
 *   IPFS_API_URL     – Kubo RPC endpoint (e.g. http://127.0.0.1:5001).
 *                      When unset, publishing is disabled and `isConfigured()`
 *                      returns false so dependent workers stay idle.
 *   IPFS_GATEWAY_URL – Public gateway base used for verification links
 *                      (defaults to https://ipfs.io/ipfs/).
 */

import { randomBytes } from "crypto";

const DEFAULT_IPFS_GATEWAY_URL = "https://ipfs.io/ipfs/";
const DEFAULT_ADD_TIMEOUT_MS = 30_000;

export interface IpfsAddResult {
  /** Content identifier (CIDv1) returned by the IPFS node. */
  cid: string;
}

export interface IpfsClient {
  /** True when an IPFS API endpoint is configured and publishing can run. */
  isConfigured(): boolean;
  /** Pins `content` on the node and returns its content identifier. */
  add(content: Buffer, filename: string): Promise<IpfsAddResult>;
  /** Resolves the public gateway URL used to verify a CID. */
  gatewayUrl(cid: string): string;
}

export interface IpfsClientOptions {
  apiUrl?: string;
  gatewayUrl?: string;
  timeoutMs?: number;
  fetchFn?: typeof fetch;
}

export class IpfsApiError extends Error {
  readonly status: number | undefined;

  constructor(message: string, status?: number) {
    super(message);
    this.name = "IpfsApiError";
    this.status = status;
  }
}

function normalizeBaseUrl(url: string): string {
  return url.trim().replace(/\/+$/, "");
}

function buildGatewayUrl(base: string, cid: string): string {
  const normalized = normalizeBaseUrl(base);
  return `${normalized}/${cid}`;
}

/** Strips characters that would break the multipart header. */
function sanitizeFilename(filename: string): string {
  const cleaned = filename.replace(/["\r\n\\]/g, "_").trim();
  return cleaned.length > 0 ? cleaned : "snapshot.json";
}

/** Kubo answers with newline delimited JSON; the last line holds the result. */
function parseAddResponse(body: string): string | undefined {
  const lines = body.split("\n").filter((line) => line.trim().length > 0);
  const last = lines[lines.length - 1];
  if (!last) return undefined;
  try {
    const parsed = JSON.parse(last) as { Hash?: unknown };
    return typeof parsed.Hash === "string" && parsed.Hash.length > 0
      ? parsed.Hash
      : undefined;
  } catch {
    return undefined;
  }
}

/** Wraps the snapshot bytes in a single-part multipart/form-data body. */
function multipartBody(
  boundary: string,
  filename: string,
  content: Buffer,
): Buffer {
  const safeName = sanitizeFilename(filename);
  const header = Buffer.from(
    `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="file"; filename="${safeName}"\r\n` +
      `Content-Type: application/json\r\n\r\n`,
    "utf8",
  );
  const footer = Buffer.from(`\r\n--${boundary}--\r\n`, "utf8");
  return Buffer.concat([header, content, footer]);
}

export class IpfsHttpClient implements IpfsClient {
  constructor(private readonly options: IpfsClientOptions = {}) {}

  private apiUrl(): string {
    const configured = this.options.apiUrl ?? process.env.IPFS_API_URL ?? "";
    return normalizeBaseUrl(configured);
  }

  isConfigured(): boolean {
    return this.apiUrl().length > 0;
  }

  gatewayUrl(cid: string): string {
    const base =
      this.options.gatewayUrl ??
      process.env.IPFS_GATEWAY_URL ??
      DEFAULT_IPFS_GATEWAY_URL;
    return buildGatewayUrl(base, cid);
  }

  async add(content: Buffer, filename: string): Promise<IpfsAddResult> {
    const apiUrl = this.apiUrl();
    if (!apiUrl) {
      throw new IpfsApiError(
        "IPFS API endpoint is not configured (set IPFS_API_URL).",
      );
    }

    const url =
      `${apiUrl}/api/v0/add` +
      "?cid-version=1&pin=true&raw-leaves=true&wrap-with-directory=false";
    const boundary = `----StellarFlow${randomBytes(12).toString("hex")}`;

    const response = await this.fetchFn()(url, {
      method: "POST",
      headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
      body: new Uint8Array(multipartBody(boundary, filename, content)),
      signal: AbortSignal.timeout(
        this.options.timeoutMs ?? DEFAULT_ADD_TIMEOUT_MS,
      ),
    });

    if (!response.ok) {
      throw new IpfsApiError(
        `IPFS add request failed with HTTP ${response.status}.`,
        response.status,
      );
    }

    const cid = parseAddResponse(await response.text());
    if (!cid) {
      throw new IpfsApiError("IPFS add response did not contain a CID.");
    }
    return { cid };
  }

  private fetchFn(): typeof fetch {
    return this.options.fetchFn ?? fetch;
  }
}

/** Shared singleton used by the governance result export worker. */
export const ipfsClient: IpfsClient = new IpfsHttpClient();
