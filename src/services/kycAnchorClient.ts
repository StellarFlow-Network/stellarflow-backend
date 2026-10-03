/**
 * Forwards encrypted SEP-12 KYC payloads to a configured regional remittance
 * anchor.
 *
 * The forwarder is deterministic and injectable: when `KYC_ANCHOR_URL` is not
 * configured it performs no network I/O and returns PROCESSING, and tests can
 * pass a stub implementation of `KycAnchorForwarder` instead of hitting the
 * network. Only the encrypted payload is ever transmitted – the anchor never
 * receives plaintext customer data from this process.
 */

import {
  SEP12_STATUS,
  asSep12Status,
  type Sep12Fields,
  type Sep12Status,
} from "./kycTypes";

/** The encrypted envelope handed to the anchor. */
export interface AnchorSubmission {
  reference: string;
  account: string | null;
  memo: string | null;
  memoType: string | null;
  /** AES-256-GCM ciphertext of the KYC fields – never plaintext. */
  encryptedPayload: string;
  /** Names (not values) of the fields contained in the payload. */
  fields: string[];
}

/** The anchor's verdict for a submitted customer. */
export interface AnchorDecision {
  status: Sep12Status;
  message?: string;
  fields?: Sep12Fields;
  anchorReference?: string;
  provider?: string;
}

export interface KycAnchorForwarder {
  isConfigured(): boolean;
  submit(submission: AnchorSubmission): Promise<AnchorDecision>;
}

export class KycAnchorError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "KycAnchorError";
  }
}

export class KycAnchorClient implements KycAnchorForwarder {
  constructor(
    private readonly forwardUrl?: string,
    private readonly fetchImpl: typeof globalThis.fetch = globalThis.fetch,
  ) {}

  private resolveUrl(): string | undefined {
    return (
      this.forwardUrl?.trim() ||
      process.env.KYC_ANCHOR_URL?.trim() ||
      undefined
    );
  }

  isConfigured(): boolean {
    return Boolean(this.resolveUrl());
  }

  async submit(submission: AnchorSubmission): Promise<AnchorDecision> {
    const url = this.resolveUrl();
    if (!url) {
      // No anchor configured: leave the customer in PROCESSING locally. This is
      // the deterministic, offline-safe path used in development and tests.
      return { status: SEP12_STATUS.PROCESSING, provider: "local" };
    }

    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(submission),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new KycAnchorError(
        `KYC anchor forwarding failed for ${submission.reference}: ${message}`,
      );
    }

    if (!response.ok) {
      throw new KycAnchorError(
        `KYC anchor forwarding returned HTTP ${response.status} for ${submission.reference}`,
      );
    }

    let body: unknown;
    try {
      body = await response.json();
    } catch {
      throw new KycAnchorError(
        `KYC anchor returned a non-JSON response for ${submission.reference}`,
      );
    }

    const record =
      typeof body === "object" && body !== null
        ? (body as Record<string, unknown>)
        : {};

    const decision: AnchorDecision = {
      status: asSep12Status(record.status),
      provider: "anchor",
    };

    if (typeof record.message === "string") decision.message = record.message;
    if (isFieldMap(record.fields)) decision.fields = record.fields;
    if (typeof record.id === "string") decision.anchorReference = record.id;
    else if (typeof record.anchor_reference === "string") {
      decision.anchorReference = record.anchor_reference;
    }

    return decision;
  }
}

function isFieldMap(value: unknown): value is Sep12Fields {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export const kycAnchorClient = new KycAnchorClient();
