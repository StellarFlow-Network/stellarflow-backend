import { httpClient } from "../lib/httpClient.js";
import { OUTGOING_HTTP_TIMEOUT_MS } from "../utils/httpTimeout.js";
import type {
  AddressScreenResult,
  ThirdPartyScreeningResponse,
} from "./complianceTypes";

export class ComplianceScreeningApiError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ComplianceScreeningApiError";
  }
}

function parseSanctioned(body: ThirdPartyScreeningResponse): boolean {
  if (typeof body.sanctioned === "boolean") return body.sanctioned;
  if (typeof body.is_sanctioned === "boolean") return body.is_sanctioned;
  if (typeof body.hit === "boolean") return body.hit;
  if (typeof body.isHit === "boolean") return body.isHit;
  if (Array.isArray(body.matches) && body.matches.length > 0) return true;
  return false;
}

/**
 * Client for a third-party OFAC / sanctions screening API.
 *
 * Expected contract (override URL via COMPLIANCE_SCREENING_API_URL):
 * POST { address, network: "stellar" }
 * Response: { sanctioned: boolean } (also accepts is_sanctioned / hit / matches)
 */
export class ComplianceScreeningClient {
  constructor(
    private readonly apiUrl = process.env.COMPLIANCE_SCREENING_API_URL?.trim(),
    private readonly apiKey = process.env.COMPLIANCE_SCREENING_API_KEY?.trim(),
  ) {}

  isConfigured(): boolean {
    return Boolean(this.apiUrl);
  }

  async screenPublicKey(publicKey: string): Promise<AddressScreenResult> {
    if (!this.apiUrl) {
      throw new ComplianceScreeningApiError(
        "COMPLIANCE_SCREENING_API_URL is not configured",
      );
    }

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (this.apiKey) {
      headers.Authorization = `Bearer ${this.apiKey}`;
    }

    try {
      const response = await httpClient.post<ThirdPartyScreeningResponse>(
        this.apiUrl,
        { address: publicKey, network: "stellar" },
        { headers, timeout: OUTGOING_HTTP_TIMEOUT_MS },
      );
      const body = response.data ?? {};
      return {
        publicKey,
        sanctioned: parseSanctioned(body),
        provider: body.provider ?? "compliance_screening_api",
        raw: body,
      };
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Unknown screening error";
      throw new ComplianceScreeningApiError(
        `Compliance screening API failed for ${publicKey}: ${message}`,
      );
    }
  }
}

export const complianceScreeningClient = new ComplianceScreeningClient();
