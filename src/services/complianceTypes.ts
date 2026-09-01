export const REMITTANCE_STATUS = {
  PENDING_SCREENING: "pending_screening",
  SCREENING: "screening",
  FLAGGED_COMPLIANCE: "flagged_compliance",
  COMPLIANCE_CLEARED: "compliance_cleared",
  PAYOUT_RELAYED: "payout_relayed",
  PAYOUT_HALTED: "payout_halted",
} as const;

export type RemittanceStatus =
  (typeof REMITTANCE_STATUS)[keyof typeof REMITTANCE_STATUS];

export interface ScreeningHit {
  publicKey: string;
  role: "sender" | "recipient";
  sanctioned: boolean;
  provider: string;
  raw?: unknown;
}

export interface AddressScreenResult {
  publicKey: string;
  sanctioned: boolean;
  provider: string;
  raw?: unknown;
}

export interface ThirdPartyScreeningResponse {
  sanctioned?: boolean;
  is_sanctioned?: boolean;
  hit?: boolean;
  isHit?: boolean;
  matches?: unknown;
  provider?: string;
}
