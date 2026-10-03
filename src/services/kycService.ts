/**
 * SEP-12 customer service.
 *
 * Orchestrates the three SEP-12 customer operations:
 *
 *   GET    /customer        – look a customer up by id or account/memo/memo_type
 *   PUT    /customer        – create or update a customer, returning id/status
 *   DELETE /customer/:id    – remove a customer
 *
 * Responsibilities:
 *  - validate the customer identity and memo semantics,
 *  - keep the KYC payload encrypted at rest (never persist plaintext),
 *  - derive the SEP-12 status (ACCEPTED/PROCESSING/NEEDS_INFO/REJECTED),
 *  - forward the *encrypted* payload to the configured remittance anchor and
 *    adopt the anchor's verdict, honouring the allowed status transitions.
 *
 * Dependencies (store, encryption, anchor, clock, id factory) are injected so
 * the whole service can be tested deterministically without a database or
 * network access.
 */

import { randomUUID } from "node:crypto";
import { KycAnchorClient, type KycAnchorForwarder } from "./kycAnchorClient";
import { KycEncryptionService } from "./kycEncryption";
import { PrismaKycStore, type KycCustomerRow, type KycStore } from "./kycStore";
import {
  DEFAULT_FIELD_SPECS,
  SEP12_RESERVED_KEYS,
  SEP12_STATUS,
  applyTransition,
  asSep12Status,
  canTransition,
  fieldSpecsFor,
  isValidStellarAccount,
  missingRequiredFields,
  parseMemoType,
  validateMemo,
  type GetCustomerParams,
  type KycPayload,
  type MemoType,
  type PutCustomerResult,
  type Sep12CustomerResponse,
  type Sep12FieldSpec,
  type Sep12Fields,
  type Sep12ProvidedField,
  type Sep12Status,
  Sep12NotFoundError,
  Sep12ValidationError,
} from "./kycTypes";

export interface KycServiceDependencies {
  store: KycStore;
  encryption?: KycEncryptionService;
  anchor?: KycAnchorForwarder;
  now?: () => Date;
  idFactory?: () => string;
}

interface PutInput {
  id: string | undefined;
  account: string | undefined;
  memo: string | undefined;
  memoType: MemoType | undefined;
  fields: KycPayload;
}

export class KycService {
  private readonly store: KycStore;
  private readonly encryption: KycEncryptionService;
  private readonly anchor: KycAnchorForwarder;
  private readonly now: () => Date;
  private readonly idFactory: () => string;

  constructor(deps: KycServiceDependencies) {
    this.store = deps.store;
    this.encryption = deps.encryption ?? new KycEncryptionService();
    this.anchor = deps.anchor ?? new KycAnchorClient();
    this.now = deps.now ?? (() => new Date());
    this.idFactory = deps.idFactory ?? (() => randomUUID());
  }

  /**
   * GET /customer. Returns the customer, or `null` when no customer exists for
   * the supplied identity (the route maps that to HTTP 404).
   */
  async getCustomer(
    params: GetCustomerParams,
  ): Promise<Sep12CustomerResponse | null> {
    const row = await this.resolveCustomer(params);
    if (!row) return null;
    return this.buildResponse(row);
  }

  /**
   * PUT /customer. Creates the customer when the identity is unknown, updates
   * it otherwise, and returns the SEP-12 `{ id, status, message?, fields? }`
   * envelope.
   */
  async putCustomer(body: unknown): Promise<PutCustomerResult> {
    const input = this.parsePutBody(body);

    const existing = input.id
      ? await this.store.findById(input.id)
      : await this.store.findByIdentity(
          input.account as string,
          input.memoType ?? null,
          input.memo ?? null,
        );

    if (input.id && !existing) {
      throw new Sep12NotFoundError(`Unknown customer id '${input.id}'`);
    }

    const currentPayload: KycPayload = existing
      ? this.encryption.decryptPayload(existing.encryptedPayload)
      : {};

    // New values win over previously stored ones.
    const mergedPayload: KycPayload = { ...currentPayload, ...input.fields };
    const encryptedPayload = this.encryption.encryptPayload(mergedPayload);

    const reference = existing?.id ?? this.idFactory();
    const account = input.account ?? existing?.account ?? null;
    const memo = input.memo ?? existing?.memo ?? null;
    const memoType = input.memoType ?? (existing?.memoType as MemoType | null) ?? null;

    const currentStatus: Sep12Status = existing
      ? asSep12Status(existing.status)
      : SEP12_STATUS.PROCESSING;

    let desiredStatus: Sep12Status;
    let message: string | null = existing?.message ?? null;
    let fieldsRequested: Sep12Fields | null = asFieldsOrNull(
      existing?.fieldsRequested,
    );
    let anchorReference: string | null = existing?.anchorReference ?? null;
    let provider: string | null = existing?.provider ?? null;

    const missing = missingRequiredFields(mergedPayload);

    if (missing.length > 0) {
      // Incomplete customer: ask for the missing fields instead of forwarding.
      desiredStatus = SEP12_STATUS.NEEDS_INFO;
      fieldsRequested = fieldSpecsFor(missing);
      message = "Additional customer information is required.";
    } else {
      const decision = await this.anchor.submit({
        reference,
        account,
        memo,
        memoType,
        encryptedPayload,
        fields: Object.keys(mergedPayload),
      });

      desiredStatus = decision.status;
      fieldsRequested = null;
      message = decision.message ?? null;
      anchorReference = decision.anchorReference ?? anchorReference;
      provider = decision.provider ?? provider;
    }

    const nextStatus = this.negotiateStatus(currentStatus, desiredStatus);

    const row = existing
      ? await this.store.update(existing.id, {
          status: nextStatus,
          message,
          encryptedPayload,
          fieldsRequested,
          anchorReference,
          provider,
        })
      : await this.store.create({
          id: reference,
          account,
          memo,
          memoType,
          status: nextStatus,
          message,
          encryptedPayload,
          fieldsRequested,
          anchorReference,
          provider,
        });

    const result: PutCustomerResult = { id: row.id, status: nextStatus };
    if (message) result.message = message;
    if (nextStatus === SEP12_STATUS.NEEDS_INFO && fieldsRequested) {
      result.fields = fieldsRequested;
    }
    return result;
  }

  /** DELETE /customer/:id. Returns false when the customer did not exist. */
  async deleteCustomer(id: string): Promise<boolean> {
    if (!id || !id.trim()) {
      throw new Sep12ValidationError("'id' must be a non-empty string");
    }
    const row = await this.store.findById(id);
    if (!row) return false;
    await this.store.delete(id);
    return true;
  }

  /**
   * Explicitly move a customer between SEP-12 statuses (used by anchor
   * callbacks / operators). Throws `Sep12TransitionError` for illegal moves.
   */
  async updateStatus(
    id: string,
    status: Sep12Status,
    message?: string,
  ): Promise<Sep12CustomerResponse | null> {
    const row = await this.store.findById(id);
    if (!row) return null;

    const current = asSep12Status(row.status);
    const next = applyTransition(current, status);

    const updated = await this.store.update(id, {
      status: next,
      message: message ?? row.message,
      encryptedPayload: row.encryptedPayload,
      fieldsRequested:
        next === SEP12_STATUS.NEEDS_INFO
          ? asFieldsOrNull(row.fieldsRequested)
          : null,
      anchorReference: row.anchorReference,
      provider: row.provider,
    });

    return this.buildResponse(updated);
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  private async resolveCustomer(
    params: GetCustomerParams,
  ): Promise<KycCustomerRow | null> {
    if (params.id) {
      return this.store.findById(params.id);
    }

    if (params.account) {
      if (!isValidStellarAccount(params.account)) {
        throw new Sep12ValidationError(
          "'account' must be a valid Stellar account id",
        );
      }
      if (params.memo !== undefined && params.memoType === undefined) {
        throw new Sep12ValidationError(
          "'memo_type' is required when 'memo' is provided",
        );
      }
      if (params.memoType !== undefined && params.memo === undefined) {
        throw new Sep12ValidationError(
          "'memo' is required when 'memo_type' is provided",
        );
      }
      if (params.memo !== undefined && params.memoType !== undefined) {
        validateMemo(params.memo, params.memoType);
      }
      return this.store.findByIdentity(
        params.account,
        params.memoType ?? null,
        params.memo ?? null,
      );
    }

    throw new Sep12ValidationError(
      "Either 'id' or 'account' must be supplied",
    );
  }

  private parsePutBody(body: unknown): PutInput {
    if (typeof body !== "object" || body === null || Array.isArray(body)) {
      throw new Sep12ValidationError("Request body must be a JSON object");
    }
    const record = body as Record<string, unknown>;

    const rawId = record.id;
    let id: string | undefined;
    if (rawId !== undefined) {
      if (typeof rawId !== "string" || rawId.trim() === "") {
        throw new Sep12ValidationError("'id' must be a non-empty string");
      }
      id = rawId.trim();
    }

    const rawAccount = record.account;
    let account: string | undefined;
    if (rawAccount !== undefined) {
      if (typeof rawAccount !== "string" || rawAccount.trim() === "") {
        throw new Sep12ValidationError("'account' must be a non-empty string");
      }
      account = rawAccount.trim();
      if (!isValidStellarAccount(account)) {
        throw new Sep12ValidationError(
          "'account' must be a valid Stellar account id",
        );
      }
    }

    if (id === undefined && account === undefined) {
      throw new Sep12ValidationError(
        "Either 'id' or 'account' must be supplied to create or update a customer",
      );
    }

    const memoType = parseMemoType(record.memo_type);
    let memo: string | undefined;
    if (record.memo !== undefined && record.memo !== null && record.memo !== "") {
      if (typeof record.memo !== "string") {
        throw new Sep12ValidationError("'memo' must be a string");
      }
      memo = record.memo.trim();
    }

    if (memo !== undefined && memoType === undefined) {
      throw new Sep12ValidationError(
        "'memo_type' is required when 'memo' is provided",
      );
    }
    if (memoType !== undefined && memo === undefined) {
      throw new Sep12ValidationError(
        "'memo' is required when 'memo_type' is provided",
      );
    }
    if (memo !== undefined && memoType !== undefined) {
      validateMemo(memo, memoType);
    }

    const fields: KycPayload = {};
    for (const [key, value] of Object.entries(record)) {
      if (SEP12_RESERVED_KEYS.has(key)) continue;
      fields[key] = value;
    }

    return { id, account, memo, memoType, fields };
  }

  /**
   * Pick the status to persist. A new record takes the desired status as-is;
   * an existing record only moves when the transition is legal, so a terminal
   * ACCEPTED/REJECTED decision is never regressed by a later update.
   */
  private negotiateStatus(
    current: Sep12Status,
    desired: Sep12Status,
  ): Sep12Status {
    if (desired === current) return current;
    return canTransition(current, desired) ? desired : current;
  }

  private buildResponse(row: KycCustomerRow): Sep12CustomerResponse {
    const payload = this.encryption.decryptPayload(row.encryptedPayload);
    const status = asSep12Status(row.status);

    const response: Sep12CustomerResponse = {
      id: row.id,
      status,
      provided_fields: buildProvidedFields(payload),
    };

    if (row.message) response.message = row.message;
    if (status === SEP12_STATUS.NEEDS_INFO) {
      const requested = asFieldsOrNull(row.fieldsRequested);
      if (requested) response.fields = requested;
    }

    for (const [key, value] of Object.entries(payload)) {
      if (SEP12_RESERVED_KEYS.has(key)) continue;
      response[key] = value;
    }

    return response;
  }
}

function asFieldsOrNull(value: unknown): Sep12Fields | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  return value as Sep12Fields;
}

function buildProvidedFields(
  payload: KycPayload,
): Record<string, Sep12ProvidedField> {
  const provided: Record<string, Sep12ProvidedField> = {};
  for (const [key, value] of Object.entries(payload)) {
    if (SEP12_RESERVED_KEYS.has(key)) continue;
    if (value === undefined || value === null || value === "") continue;
    const spec: Sep12FieldSpec = DEFAULT_FIELD_SPECS[key] ?? {
      type: "string",
      description: key,
    };
    const entry: Sep12ProvidedField = {
      type: spec.type,
      description: spec.description,
      status: "provided",
    };
    provided[key] = entry;
  }
  return provided;
}

/** Convenience factory used by the route layer / workers. */
export function createKycService(deps: KycServiceDependencies): KycService {
  return new KycService(deps);
}

export { PrismaKycStore };
