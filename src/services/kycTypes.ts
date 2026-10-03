/**
 * SEP-12 Customer Information Transfer (KYC) – shared types.
 *
 * Implements the vocabulary defined by the Stellar SEP-12 specification:
 * https://github.com/stellar/stellar-protocol/blob/master/ecosystem/sep-0012.md
 *
 * Nothing in this module touches the network or the database – it is pure
 * type/validation surface shared by the service layer and the HTTP routes.
 */

// ---------------------------------------------------------------------------
// Customer status
// ---------------------------------------------------------------------------

/** The four statuses a SEP-12 customer may be in. */
export const SEP12_STATUS = {
  ACCEPTED: "ACCEPTED",
  PROCESSING: "PROCESSING",
  NEEDS_INFO: "NEEDS_INFO",
  REJECTED: "REJECTED",
} as const;

export type Sep12Status = (typeof SEP12_STATUS)[keyof typeof SEP12_STATUS];

/** All statuses, in the order the spec documents them. */
export const SEP12_STATUSES: readonly Sep12Status[] = [
  SEP12_STATUS.PROCESSING,
  SEP12_STATUS.NEEDS_INFO,
  SEP12_STATUS.ACCEPTED,
  SEP12_STATUS.REJECTED,
];

/**
 * Allowed status transitions. `ACCEPTED` and `REJECTED` are terminal: once a
 * customer is approved or rejected a later KYC update must not silently
 * downgrade that decision.
 */
export const SEP12_STATUS_TRANSITIONS: Record<
  Sep12Status,
  readonly Sep12Status[]
> = {
  [SEP12_STATUS.PROCESSING]: [
    SEP12_STATUS.ACCEPTED,
    SEP12_STATUS.NEEDS_INFO,
    SEP12_STATUS.REJECTED,
  ],
  [SEP12_STATUS.NEEDS_INFO]: [
    SEP12_STATUS.PROCESSING,
    SEP12_STATUS.ACCEPTED,
    SEP12_STATUS.REJECTED,
  ],
  [SEP12_STATUS.ACCEPTED]: [],
  [SEP12_STATUS.REJECTED]: [],
};

/** Narrowing helper for untrusted (env, anchor, DB) status values. */
export function isSep12Status(value: unknown): value is Sep12Status {
  return (
    typeof value === "string" &&
    (SEP12_STATUSES as readonly string[]).includes(value)
  );
}

/** Coerce an untrusted status to a valid one, defaulting to PROCESSING. */
export function asSep12Status(value: unknown): Sep12Status {
  return isSep12Status(value) ? value : SEP12_STATUS.PROCESSING;
}

/** True when moving from `from` to `to` is a legal SEP-12 transition. */
export function canTransition(
  from: Sep12Status,
  to: Sep12Status,
): boolean {
  if (from === to) return true;
  const allowed = SEP12_STATUS_TRANSITIONS[from] ?? [];
  return allowed.includes(to);
}

/**
 * Validate a transition, throwing when it is not permitted.
 * A transition to the current status is a no-op and therefore allowed.
 */
export function applyTransition(
  from: Sep12Status,
  to: Sep12Status,
): Sep12Status {
  if (canTransition(from, to)) return to;
  throw new Sep12TransitionError(
    `Invalid customer status transition: ${from} -> ${to}`,
  );
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/** Malformed or missing request parameters – surfaced as HTTP 400. */
export class Sep12ValidationError extends Error {
  public readonly code = "VALIDATION_ERROR";

  constructor(message: string) {
    super(message);
    this.name = "Sep12ValidationError";
  }
}

/** Unknown customer – surfaced as HTTP 404. */
export class Sep12NotFoundError extends Error {
  public readonly code = "NOT_FOUND";

  constructor(message: string) {
    super(message);
    this.name = "Sep12NotFoundError";
  }
}

/** Illegal status transition – surfaced as HTTP 409. */
export class Sep12TransitionError extends Error {
  public readonly code = "CONFLICT";

  constructor(message: string) {
    super(message);
    this.name = "Sep12TransitionError";
  }
}

// ---------------------------------------------------------------------------
// Field vocabulary
// ---------------------------------------------------------------------------

export const SEP12_FIELD_TYPES = [
  "string",
  "binary",
  "number",
  "date",
] as const;

export type Sep12FieldType = (typeof SEP12_FIELD_TYPES)[number];

/** A single entry in the `fields` map returned when status is NEEDS_INFO. */
export interface Sep12FieldSpec {
  type: Sep12FieldType;
  description: string;
  choices?: readonly string[];
  optional?: boolean;
}

export type Sep12Fields = Record<string, Sep12FieldSpec>;

/** A field the customer has already supplied, as reported in `provided_fields`. */
export interface Sep12ProvidedField {
  type: Sep12FieldType;
  description: string;
  status: "provided";
}

/** KYC fields are free-form; the service encrypts the whole payload. */
export type KycPayload = Record<string, unknown>;

/** Fields required before a customer can be forwarded to an anchor. */
export const REQUIRED_KYC_FIELDS: readonly string[] = [
  "first_name",
  "last_name",
  "email_address",
  "id_type",
  "id_number",
];

/** Canonical descriptions/choices for the fields this backend understands. */
export const DEFAULT_FIELD_SPECS: Sep12Fields = {
  first_name: { type: "string", description: "Customer's first name" },
  last_name: { type: "string", description: "Customer's last name" },
  email_address: { type: "string", description: "Customer's email address" },
  id_type: {
    type: "string",
    description: "Government-issued identification document type",
    choices: ["passport", "drivers_license", "national_id"],
  },
  id_number: {
    type: "string",
    description: "Government-issued identification document number",
  },
  date_of_birth: {
    type: "date",
    description: "Customer's date of birth (YYYY-MM-DD)",
    optional: true,
  },
  address: { type: "string", description: "Customer's residential address" },
};

/**
 * Keys that belong to the SEP-12 envelope rather than the customer payload and
 * must never be stored as (or returned within) KYC fields.
 */
export const SEP12_RESERVED_KEYS: ReadonlySet<string> = new Set([
  "id",
  "account",
  "memo",
  "memo_type",
  "type",
  "fields",
  "provided_fields",
  "status",
  "message",
]);

/** Build the NEEDS_INFO `fields` map for a set of customer field names. */
export function fieldSpecsFor(names: readonly string[]): Sep12Fields {
  const specs: Sep12Fields = {};
  for (const name of names) {
    specs[name] = DEFAULT_FIELD_SPECS[name] ?? {
      type: "string",
      description: formatFieldLabel(name),
    };
  }
  return specs;
}

/** Field names whose value is missing or blank in a payload. */
export function missingRequiredFields(
  payload: KycPayload,
  required: readonly string[] = REQUIRED_KYC_FIELDS,
): string[] {
  return required.filter((name) => {
    const value = payload[name];
    if (value === undefined || value === null) return true;
    return typeof value === "string" && value.trim() === "";
  });
}

function formatFieldLabel(name: string): string {
  return name
    .split("_")
    .map((part) => (part ? part.charAt(0).toUpperCase() + part.slice(1) : part))
    .join(" ");
}

// ---------------------------------------------------------------------------
// Identity (account / memo / memo_type / id)
// ---------------------------------------------------------------------------

export const MEMO_TYPES = ["id", "text", "hash"] as const;
export type MemoType = (typeof MEMO_TYPES)[number];

const STELLAR_ACCOUNT_PATTERN = /^(G[A-Z2-7]{55}|M[A-Z2-7]{68})$/;

export function isValidStellarAccount(value: string): boolean {
  return STELLAR_ACCOUNT_PATTERN.test(value);
}

/** Parse a `memo_type` value, throwing when it is present but unrecognised. */
export function parseMemoType(value: unknown): MemoType | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string") {
    throw new Sep12ValidationError("'memo_type' must be a string");
  }
  const lowered = value.toLowerCase();
  if ((MEMO_TYPES as readonly string[]).includes(lowered)) {
    return lowered as MemoType;
  }
  throw new Sep12ValidationError(
    `'memo_type' must be one of: ${MEMO_TYPES.join(", ")}`,
  );
}

/** Validate a memo against its declared type (SEP-11 memo semantics). */
export function validateMemo(memo: string, memoType: MemoType): void {
  if (memoType === "id" && !/^\d+$/.test(memo)) {
    throw new Sep12ValidationError(
      "'memo' must be a numeric string when 'memo_type' is 'id'",
    );
  }
  if (memoType === "hash" && !/^[0-9a-fA-F]{64}$/.test(memo)) {
    throw new Sep12ValidationError(
      "'memo' must be a 64-character hex string when 'memo_type' is 'hash'",
    );
  }
  if (memoType === "text" && Buffer.byteLength(memo, "utf8") > 28) {
    throw new Sep12ValidationError(
      "'memo' must be at most 28 bytes when 'memo_type' is 'text'",
    );
  }
}

// ---------------------------------------------------------------------------
// Wire shapes
// ---------------------------------------------------------------------------

/** Parameters accepted by GET /customer. */
export interface GetCustomerParams {
  id: string | undefined;
  account: string | undefined;
  memo: string | undefined;
  memoType: MemoType | undefined;
}

/** Response body for GET /customer. */
export interface Sep12CustomerResponse {
  id: string;
  status: Sep12Status;
  message?: string;
  fields?: Sep12Fields;
  provided_fields?: Record<string, Sep12ProvidedField>;
  [key: string]: unknown;
}

/** Response body for PUT /customer. */
export interface PutCustomerResult {
  id: string;
  status: Sep12Status;
  message?: string;
  fields?: Sep12Fields;
}
