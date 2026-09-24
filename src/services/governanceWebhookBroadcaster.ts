import crypto from "crypto";
import prisma from "../lib/prisma";
import { httpClient } from "../lib/httpClient";
import { createFetcherLogger } from "../utils/logger";
import { OUTGOING_HTTP_TIMEOUT_MS } from "../utils/httpTimeout";

export const GOVERNANCE_WEBHOOK_SIGNATURE_HEADER = "x-stellarflow-signature";
export const GOVERNANCE_WEBHOOK_EVENT_HEADER = "x-stellarflow-event";
export const GOVERNANCE_WEBHOOK_EVENT_ID_HEADER = "x-stellarflow-event-id";
export const GOVERNANCE_WEBHOOK_TIMESTAMP_HEADER = "x-stellarflow-timestamp";
export const GOVERNANCE_WEBHOOK_SIGNATURE_ALGORITHM = "sha256";
export const GOVERNANCE_WEBHOOK_SIGNATURE_PREFIX = "sha256=";

export const GOVERNANCE_WEBHOOK_MAX_ATTEMPTS = 5;
export const GOVERNANCE_WEBHOOK_INITIAL_RETRY_MS = 1_000;
export const GOVERNANCE_WEBHOOK_MAX_RETRY_MS = 60_000;
export const GOVERNANCE_WEBHOOK_DISABLE_AFTER_FAILURES = 10;

export type GovernanceWebhookEventType =
  | "proposal.executed"
  | "proposal.cancelled"
  | "proposal.expired";

export const GOVERNANCE_WEBHOOK_EVENT_TYPES: GovernanceWebhookEventType[] = [
  "proposal.executed",
  "proposal.cancelled",
  "proposal.expired",
];

export interface GovernanceProposalWebhookData {
  proposalId: string;
  contractId?: string | null;
  status: string;
  title?: string | null;
  actionType?: string | null;
  transactionHash?: string | null;
  expiresAt?: Date | string | null;
  executedAt?: Date | string | null;
  cancelledAt?: Date | string | null;
  reason?: string | null;
}

export interface GovernanceWebhookPayload {
  event: GovernanceWebhookEventType;
  eventId: string;
  timestamp: string;
  data: GovernanceProposalWebhookData;
}

export interface GovernanceWebhookEndpoint {
  id: string;
  name: string | null;
  url: string;
  secret: string;
  events: GovernanceWebhookEventType[];
  active: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export interface PublicGovernanceWebhookEndpoint {
  id: string;
  name: string | null;
  url: string;
  secret: string;
  events: GovernanceWebhookEventType[];
  active: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export interface RegisterGovernanceWebhookInput {
  url: string;
  secret?: string;
  name?: string;
  events?: GovernanceWebhookEventType[];
  active?: boolean;
}

export type GovernanceWebhookDeliveryStatus =
  | "pending"
  | "retrying"
  | "delivered"
  | "failed";

export interface GovernanceWebhookDeliveryRecord {
  id: string;
  endpointId: string;
  endpointUrl: string;
  eventType: string;
  proposalId: string;
  contractId: string | null;
  status: GovernanceWebhookDeliveryStatus;
  attempts: number;
  maxAttempts: number;
  responseStatus: number | null;
  responseBody: string | null;
  errorMessage: string | null;
  createdAt: Date;
  updatedAt: Date;
  deliveredAt: Date | null;
}

export interface GovernanceWebhookDeliveryFilters {
  endpointId?: string;
  eventType?: string;
  proposalId?: string;
  status?: string;
  limit?: number;
  offset?: number;
}

export interface GovernanceWebhookDeliveryHistory {
  deliveries: GovernanceWebhookDeliveryRecord[];
  total: number;
  limit: number;
  offset: number;
}

export interface GovernanceWebhookDeliveryStats {
  pending: number;
  retrying: number;
  delivered: number;
  failed: number;
  total: number;
}

interface DbEndpointRow {
  id: string;
  name: string | null;
  url: string;
  secret: string;
  events: unknown;
  active: boolean;
  created_at: Date;
  updated_at: Date;
}

interface DbPendingDeliveryRow {
  id: string;
  endpoint_id: string;
  endpoint_url: string;
  event_type: string;
  proposal_id: string;
  raw_body: string;
  signature: string;
  event_id: string;
  event_timestamp: string;
  attempts: number;
  max_attempts: number;
}

interface DbDeliveryRow {
  id: string;
  endpoint_id: string;
  endpoint_url: string;
  event_type: string;
  proposal_id: string;
  contract_id: string | null;
  status: string;
  attempts: number;
  max_attempts: number;
  response_status: number | null;
  response_body: string | null;
  error_message: string | null;
  created_at: Date;
  updated_at: Date;
  delivered_at: Date | null;
}

export function signGovernanceWebhookPayload(
  body: string | Buffer,
  secret: string,
): string {
  const digest = crypto
    .createHmac(GOVERNANCE_WEBHOOK_SIGNATURE_ALGORITHM, secret)
    .update(body)
    .digest("hex");
  return `${GOVERNANCE_WEBHOOK_SIGNATURE_PREFIX}${digest}`;
}

export function verifyGovernanceWebhookSignature(
  body: string | Buffer,
  signature: string | undefined | null,
  secret: string,
): boolean {
  if (!signature || !secret) {
    return false;
  }

  const expected = Buffer.from(signGovernanceWebhookPayload(body, secret));
  const provided = Buffer.from(
    signature.startsWith(GOVERNANCE_WEBHOOK_SIGNATURE_PREFIX)
      ? signature
      : `${GOVERNANCE_WEBHOOK_SIGNATURE_PREFIX}${signature}`,
  );

  if (expected.length !== provided.length) {
    return false;
  }

  return crypto.timingSafeEqual(expected, provided);
}

function normalizeEventType(value: string): GovernanceWebhookEventType | null {
  const normalized = value.trim().toLowerCase();
  if (
    normalized === "proposal.executed" ||
    normalized === "executed" ||
    normalized === "execute"
  ) {
    return "proposal.executed";
  }
  if (
    normalized === "proposal.cancelled" ||
    normalized === "proposal.canceled" ||
    normalized === "cancelled" ||
    normalized === "canceled"
  ) {
    return "proposal.cancelled";
  }
  if (
    normalized === "proposal.expired" ||
    normalized === "expired" ||
    normalized === "expire"
  ) {
    return "proposal.expired";
  }
  return null;
}

export function normalizeGovernanceWebhookEvents(
  values: readonly string[] | undefined,
): GovernanceWebhookEventType[] {
  if (!values || values.length === 0) {
    return [...GOVERNANCE_WEBHOOK_EVENT_TYPES];
  }
  const seen = new Set<GovernanceWebhookEventType>();
  for (const value of values) {
    const normalized = normalizeEventType(value);
    if (normalized) {
      seen.add(normalized);
    }
  }
  return seen.size > 0 ? [...seen] : [...GOVERNANCE_WEBHOOK_EVENT_TYPES];
}

function parseStoredEvents(value: unknown): GovernanceWebhookEventType[] {
  if (Array.isArray(value)) {
    return normalizeGovernanceWebhookEvents(value as string[]);
  }
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value) as unknown;
      if (Array.isArray(parsed)) {
        return normalizeGovernanceWebhookEvents(parsed as string[]);
      }
    } catch {
      return [...GOVERNANCE_WEBHOOK_EVENT_TYPES];
    }
  }
  return [...GOVERNANCE_WEBHOOK_EVENT_TYPES];
}

export function maskGovernanceWebhookSecret(secret: string): string {
  if (secret.length <= 8) {
    return "********";
  }
  return `${secret.slice(0, 4)}****${secret.slice(-4)}`;
}

export class GovernanceWebhookBroadcasterService {
  private readonly logger = createFetcherLogger("GovernanceWebhookBroadcaster");
  private readonly pollIntervalMs: number;
  private readonly maxAttempts: number;
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;
  private processing = false;
  private tablesReady: Promise<void> | null = null;

  constructor(
    pollIntervalMs = Number(process.env.GOVERNANCE_WEBHOOK_POLL_INTERVAL_MS) ||
      2_000,
    maxAttempts = GOVERNANCE_WEBHOOK_MAX_ATTEMPTS,
  ) {
    this.pollIntervalMs = pollIntervalMs;
    this.maxAttempts = maxAttempts;
  }

  async start(): Promise<void> {
    if (this.running) {
      return;
    }

    this.running = true;
    await this.ensureTables();
    await this.seedFromEnvironment();

    this.timer = setInterval(() => {
      void this.processQueue().catch((error: unknown) => {
        this.logger.error("Governance webhook worker loop failed", {
          error: error instanceof Error ? error.message : String(error),
        });
      });
    }, this.pollIntervalMs);

    await this.processQueue();

    this.logger.info("Governance webhook broadcaster started", {
      pollIntervalMs: this.pollIntervalMs,
      maxAttempts: this.maxAttempts,
    });
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.running = false;
    this.logger.info("Governance webhook broadcaster stopped");
  }

  isRunning(): boolean {
    return this.running;
  }

  private ensureTables(): Promise<void> {
    if (!this.tablesReady) {
      this.tablesReady = this.createTables().catch((error: unknown) => {
        this.tablesReady = null;
        throw error;
      });
    }
    return this.tablesReady;
  }

  private async createTables(): Promise<void> {
    await prisma.$executeRawUnsafe(`
      CREATE TABLE IF NOT EXISTS governance_webhook_endpoints (
        id UUID PRIMARY KEY,
        name TEXT,
        url TEXT NOT NULL,
        secret TEXT NOT NULL,
        events JSONB NOT NULL DEFAULT '[]'::jsonb,
        active BOOLEAN NOT NULL DEFAULT TRUE,
        failure_count INT NOT NULL DEFAULT 0,
        last_delivery_at TIMESTAMPTZ,
        last_status_code INT,
        disabled_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);

    await prisma.$executeRawUnsafe(`
      CREATE UNIQUE INDEX IF NOT EXISTS governance_webhook_endpoints_url_key
        ON governance_webhook_endpoints (url);
    `);

    await prisma.$executeRawUnsafe(`
      CREATE TABLE IF NOT EXISTS governance_webhook_deliveries (
        id UUID PRIMARY KEY,
        endpoint_id UUID NOT NULL REFERENCES governance_webhook_endpoints(id) ON DELETE CASCADE,
        endpoint_url TEXT NOT NULL,
        event_type TEXT NOT NULL,
        proposal_id TEXT NOT NULL,
        contract_id TEXT,
        event_id TEXT NOT NULL,
        event_timestamp TEXT NOT NULL,
        payload JSONB NOT NULL DEFAULT '{}'::jsonb,
        raw_body TEXT NOT NULL,
        signature TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        attempts INT NOT NULL DEFAULT 0,
        max_attempts INT NOT NULL DEFAULT 5,
        response_status INT,
        response_body TEXT,
        error_message TEXT,
        next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        delivered_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT governance_webhook_deliveries_event_unique
          UNIQUE (endpoint_id, event_type, proposal_id)
      );
    `);

    await prisma.$executeRawUnsafe(`
      CREATE INDEX IF NOT EXISTS governance_webhook_deliveries_status_idx
        ON governance_webhook_deliveries (status, next_attempt_at);
    `);

    await prisma.$executeRawUnsafe(`
      CREATE INDEX IF NOT EXISTS governance_webhook_deliveries_endpoint_idx
        ON governance_webhook_deliveries (endpoint_id, created_at DESC);
    `);
  }

  private async seedFromEnvironment(): Promise<void> {
    const url = process.env.GOVERNANCE_WEBHOOK_URL?.trim();
    if (!url) {
      return;
    }

    const secret = process.env.GOVERNANCE_WEBHOOK_SECRET?.trim();
    const rawEvents = process.env.GOVERNANCE_WEBHOOK_EVENTS?.trim();

    try {
      await this.registerEndpoint({
        url,
        name: process.env.GOVERNANCE_WEBHOOK_NAME?.trim() || "environment",
        events: normalizeGovernanceWebhookEvents(
          rawEvents ? rawEvents.split(",").map((event) => event.trim()) : undefined,
        ),
        ...(secret ? { secret } : {}),
      });
      this.logger.info("Seeded governance webhook endpoint from environment", {
        url,
      });
    } catch (error) {
      this.logger.error("Failed to seed governance webhook endpoint", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  async registerEndpoint(
    input: RegisterGovernanceWebhookInput,
  ): Promise<GovernanceWebhookEndpoint> {
    await this.ensureTables();

    const id = crypto.randomUUID();
    const secret = input.secret?.trim() || crypto.randomBytes(32).toString("hex");
    const events = normalizeGovernanceWebhookEvents(input.events);
    const active = input.active ?? true;

    const rows = await prisma.$queryRawUnsafe<DbEndpointRow[]>(
      `
        INSERT INTO governance_webhook_endpoints
          (id, name, url, secret, events, active, created_at, updated_at)
        VALUES ($1, $2, $3, $4, $5::jsonb, $6, NOW(), NOW())
        ON CONFLICT (url) DO UPDATE SET
          name = EXCLUDED.name,
          secret = EXCLUDED.secret,
          events = EXCLUDED.events,
          active = EXCLUDED.active,
          disabled_at = NULL,
          updated_at = NOW()
        RETURNING id, name, url, secret, events, active, created_at, updated_at
      `,
      id,
      input.name ?? null,
      input.url,
      secret,
      JSON.stringify(events),
      active,
    );

    const row = rows[0];
    if (!row) {
      throw new Error("Failed to register governance webhook endpoint");
    }

    return this.mapEndpoint(row);
  }

  async listEndpoints(
    includeInactive = false,
  ): Promise<PublicGovernanceWebhookEndpoint[]> {
    await this.ensureTables();

    const rows = await prisma.$queryRawUnsafe<DbEndpointRow[]>(
      `
        SELECT id, name, url, secret, events, active, created_at, updated_at
        FROM governance_webhook_endpoints
        WHERE ($1::boolean = TRUE OR active = TRUE)
        ORDER BY created_at DESC
      `,
      includeInactive,
    );

    return rows.map((row: DbEndpointRow) => {
      const endpoint = this.mapEndpoint(row);
      return {
        ...endpoint,
        secret: maskGovernanceWebhookSecret(endpoint.secret),
      };
    });
  }

  async getEndpointById(id: string): Promise<GovernanceWebhookEndpoint | null> {
    await this.ensureTables();

    const rows = await prisma.$queryRawUnsafe<DbEndpointRow[]>(
      `
        SELECT id, name, url, secret, events, active, created_at, updated_at
        FROM governance_webhook_endpoints
        WHERE id = $1::uuid
        LIMIT 1
      `,
      id,
    );

    const row = rows[0];
    return row ? this.mapEndpoint(row) : null;
  }

  async deactivateEndpoint(id: string): Promise<boolean> {
    await this.ensureTables();

    const affected = await prisma.$executeRawUnsafe(
      `
        UPDATE governance_webhook_endpoints
        SET active = FALSE, disabled_at = NOW(), updated_at = NOW()
        WHERE id = $1::uuid AND active = TRUE
      `,
      id,
    );

    return Number(affected) > 0;
  }

  async broadcast(
    eventType: GovernanceWebhookEventType,
    data: GovernanceProposalWebhookData,
  ): Promise<string[]> {
    try {
      await this.ensureTables();

      const endpoints = await this.listActiveEndpointsForEvent(eventType);
      const deliveryIds: string[] = [];

      for (const endpoint of endpoints) {
        const deliveryId = await this.createDelivery(endpoint, eventType, data);
        if (deliveryId) {
          deliveryIds.push(deliveryId);
        }
      }

      if (deliveryIds.length > 0 && this.running) {
        void this.processQueue().catch((error: unknown) => {
          this.logger.error("Governance webhook dispatch failed", {
            error: error instanceof Error ? error.message : String(error),
          });
        });
      }

      if (deliveryIds.length > 0) {
        this.logger.info("Queued governance webhook deliveries", {
          eventType,
          proposalId: data.proposalId,
          deliveries: deliveryIds.length,
        });
      }

      return deliveryIds;
    } catch (error) {
      this.logger.error("Failed to broadcast governance webhook", {
        eventType,
        proposalId: data.proposalId,
        error: error instanceof Error ? error.message : String(error),
      });
      return [];
    }
  }

  broadcastProposalExecuted(
    data: GovernanceProposalWebhookData,
  ): Promise<string[]> {
    return this.broadcast("proposal.executed", {
      ...data,
      status: data.status || "Executed",
    });
  }

  broadcastProposalCancelled(
    data: GovernanceProposalWebhookData,
  ): Promise<string[]> {
    return this.broadcast("proposal.cancelled", {
      ...data,
      status: data.status || "Cancelled",
    });
  }

  broadcastProposalExpired(
    data: GovernanceProposalWebhookData,
  ): Promise<string[]> {
    return this.broadcast("proposal.expired", {
      ...data,
      status: data.status || "Queued",
    });
  }

  async processQueue(): Promise<void> {
    if (this.processing) {
      return;
    }

    this.processing = true;
    try {
      const rows = await prisma.$queryRawUnsafe<DbPendingDeliveryRow[]>(
        `
          SELECT
            d.id,
            d.endpoint_id,
            d.endpoint_url,
            d.event_type,
            d.proposal_id,
            d.raw_body,
            d.signature,
            d.event_id,
            d.event_timestamp,
            d.attempts,
            d.max_attempts
          FROM governance_webhook_deliveries d
          INNER JOIN governance_webhook_endpoints e ON e.id = d.endpoint_id
          WHERE d.status IN ('pending', 'retrying')
            AND d.next_attempt_at <= NOW()
            AND e.active = TRUE
          ORDER BY d.next_attempt_at ASC
          LIMIT 50
        `,
      );

      for (const row of rows) {
        await this.dispatchDelivery(row);
      }
    } finally {
      this.processing = false;
    }
  }

  private async dispatchDelivery(row: DbPendingDeliveryRow): Promise<void> {
    const attemptNumber = Number(row.attempts) + 1;
    const maxAttempts = Number(row.max_attempts) || this.maxAttempts;

    if (attemptNumber > maxAttempts) {
      await this.finalizeDelivery(
        row.id,
        "failed",
        attemptNumber,
        null,
        null,
        "Max attempts exceeded",
      );
      return;
    }

    try {
      const response = await httpClient.post(
        row.endpoint_url,
        row.raw_body,
        {
          headers: {
            "Content-Type": "application/json",
            [GOVERNANCE_WEBHOOK_SIGNATURE_HEADER]: row.signature,
            [GOVERNANCE_WEBHOOK_EVENT_HEADER]: row.event_type,
            [GOVERNANCE_WEBHOOK_EVENT_ID_HEADER]: row.event_id,
            [GOVERNANCE_WEBHOOK_TIMESTAMP_HEADER]: row.event_timestamp,
          },
          timeout: OUTGOING_HTTP_TIMEOUT_MS,
          transformRequest: [(data: unknown) => data],
          validateStatus: () => true,
        },
      );

      const statusCode = Number(response?.status ?? 0);
      const responseBody =
        typeof response?.data === "string"
          ? response.data
          : JSON.stringify(response?.data ?? null);

      if (statusCode >= 200 && statusCode < 300) {
        await this.finalizeDelivery(
          row.id,
          "delivered",
          attemptNumber,
          statusCode,
          responseBody,
          null,
        );
        return;
      }

      if (
        (statusCode >= 500 || statusCode === 429) &&
        attemptNumber < maxAttempts
      ) {
        await this.scheduleRetry(
          row.id,
          attemptNumber,
          statusCode,
          responseBody,
          `HTTP ${statusCode}`,
        );
        return;
      }

      await this.finalizeDelivery(
        row.id,
        "failed",
        attemptNumber,
        statusCode,
        responseBody,
        `HTTP ${statusCode}`,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);

      if (attemptNumber < maxAttempts) {
        await this.scheduleRetry(row.id, attemptNumber, null, null, message);
        return;
      }

      await this.finalizeDelivery(
        row.id,
        "failed",
        attemptNumber,
        null,
        null,
        message,
      );
    }
  }

  private async scheduleRetry(
    id: string,
    attempts: number,
    responseStatus: number | null,
    responseBody: string | null,
    errorMessage: string | null,
  ): Promise<void> {
    const nextAttemptAt = new Date(
      Date.now() + this.getRetryDelayMs(attempts),
    );

    await prisma.$executeRawUnsafe(
      `
        UPDATE governance_webhook_deliveries
        SET status = 'retrying',
            attempts = $1,
            response_status = $2,
            response_body = $3,
            error_message = $4,
            next_attempt_at = $5,
            updated_at = NOW()
        WHERE id = $6::uuid
      `,
      attempts,
      responseStatus,
      responseBody,
      errorMessage,
      nextAttemptAt,
      id,
    );

    await this.updateEndpointHealth(id, responseStatus, false);
  }

  private async finalizeDelivery(
    id: string,
    status: GovernanceWebhookDeliveryStatus,
    attempts: number,
    responseStatus: number | null,
    responseBody: string | null,
    errorMessage: string | null,
  ): Promise<void> {
    await prisma.$executeRawUnsafe(
      `
        UPDATE governance_webhook_deliveries
        SET status = $1,
            attempts = $2,
            response_status = $3,
            response_body = $4,
            error_message = $5,
            delivered_at = CASE WHEN $1 = 'delivered' THEN NOW() ELSE delivered_at END,
            updated_at = NOW()
        WHERE id = $6::uuid
      `,
      status,
      attempts,
      responseStatus,
      responseBody,
      errorMessage,
      id,
    );

    await this.updateEndpointHealth(
      id,
      responseStatus,
      status === "delivered",
    );
  }

  private async updateEndpointHealth(
    deliveryId: string,
    statusCode: number | null,
    success: boolean,
  ): Promise<void> {
    try {
      if (success) {
        await prisma.$executeRawUnsafe(
          `
            UPDATE governance_webhook_endpoints e
            SET last_delivery_at = NOW(),
                last_status_code = $1,
                failure_count = 0,
                updated_at = NOW()
            FROM governance_webhook_deliveries d
            WHERE d.id = $2::uuid AND e.id = d.endpoint_id
          `,
          statusCode,
          deliveryId,
        );
        return;
      }

      await prisma.$executeRawUnsafe(
        `
          UPDATE governance_webhook_endpoints e
          SET last_delivery_at = NOW(),
              last_status_code = $1,
              failure_count = e.failure_count + 1,
              active = CASE
                WHEN e.failure_count + 1 >= $2 THEN FALSE
                ELSE e.active
              END,
              disabled_at = CASE
                WHEN e.failure_count + 1 >= $2 THEN NOW()
                ELSE e.disabled_at
              END,
              updated_at = NOW()
          FROM governance_webhook_deliveries d
          WHERE d.id = $3::uuid AND e.id = d.endpoint_id
        `,
        statusCode,
        GOVERNANCE_WEBHOOK_DISABLE_AFTER_FAILURES,
        deliveryId,
      );
    } catch (error) {
      this.logger.warn("Failed to update governance webhook endpoint health", {
        deliveryId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private getRetryDelayMs(attemptNumber: number): number {
    return Math.min(
      GOVERNANCE_WEBHOOK_INITIAL_RETRY_MS *
        2 ** Math.max(0, attemptNumber - 1),
      GOVERNANCE_WEBHOOK_MAX_RETRY_MS,
    );
  }

  private async listActiveEndpointsForEvent(
    eventType: GovernanceWebhookEventType,
  ): Promise<GovernanceWebhookEndpoint[]> {
    const rows = await prisma.$queryRawUnsafe<DbEndpointRow[]>(
      `
        SELECT id, name, url, secret, events, active, created_at, updated_at
        FROM governance_webhook_endpoints
        WHERE active = TRUE
          AND (events = '[]'::jsonb OR events @> $1::jsonb)
        ORDER BY created_at ASC
      `,
      JSON.stringify([eventType]),
    );

    return rows.map((row: DbEndpointRow) => this.mapEndpoint(row));
  }

  private async createDelivery(
    endpoint: GovernanceWebhookEndpoint,
    eventType: GovernanceWebhookEventType,
    data: GovernanceProposalWebhookData,
  ): Promise<string | null> {
    const eventId = crypto.randomUUID();
    const timestamp = new Date().toISOString();
    const payload: GovernanceWebhookPayload = {
      event: eventType,
      eventId,
      timestamp,
      data,
    };
    const rawBody = JSON.stringify(payload);
    const signature = signGovernanceWebhookPayload(rawBody, endpoint.secret);
    const id = crypto.randomUUID();

    const affected = await prisma.$executeRawUnsafe(
      `
        INSERT INTO governance_webhook_deliveries
          (id, endpoint_id, endpoint_url, event_type, proposal_id, contract_id,
           event_id, event_timestamp, payload, raw_body, signature, status,
           attempts, max_attempts, next_attempt_at, created_at, updated_at)
        VALUES
          ($1::uuid, $2::uuid, $3, $4, $5, $6, $7, $8, $9::jsonb, $10, $11,
           'pending', 0, $12, NOW(), NOW(), NOW())
        ON CONFLICT (endpoint_id, event_type, proposal_id) DO NOTHING
      `,
      id,
      endpoint.id,
      endpoint.url,
      eventType,
      data.proposalId,
      data.contractId ?? null,
      eventId,
      timestamp,
      rawBody,
      rawBody,
      signature,
      this.maxAttempts,
    );

    return Number(affected) > 0 ? id : null;
  }

  async getDeliveryHistory(
    filters: GovernanceWebhookDeliveryFilters = {},
  ): Promise<GovernanceWebhookDeliveryHistory> {
    await this.ensureTables();

    const conditions: string[] = [];
    const params: unknown[] = [];
    let paramIndex = 1;

    if (filters.endpointId) {
      conditions.push(`endpoint_id = $${paramIndex++}::uuid`);
      params.push(filters.endpointId);
    }
    if (filters.eventType) {
      conditions.push(`event_type = $${paramIndex++}`);
      params.push(filters.eventType);
    }
    if (filters.proposalId) {
      conditions.push(`proposal_id = $${paramIndex++}`);
      params.push(filters.proposalId);
    }
    if (filters.status) {
      conditions.push(`status = $${paramIndex++}`);
      params.push(filters.status);
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    const limit = Math.min(Math.max(filters.limit ?? 50, 1), 200);
    const offset = Math.max(filters.offset ?? 0, 0);

    const rows = await prisma.$queryRawUnsafe<DbDeliveryRow[]>(
      `
        SELECT id, endpoint_id, endpoint_url, event_type, proposal_id,
               contract_id, status, attempts, max_attempts, response_status,
               response_body, error_message, created_at, updated_at, delivered_at
        FROM governance_webhook_deliveries
        ${where}
        ORDER BY created_at DESC
        LIMIT $${paramIndex++} OFFSET $${paramIndex++}
      `,
      ...params,
      limit,
      offset,
    );

    const countRows = await prisma.$queryRawUnsafe<{ count: number | bigint }[]>(
      `
        SELECT COUNT(*)::int AS count
        FROM governance_webhook_deliveries
        ${where}
      `,
      ...params,
    );

    return {
      deliveries: rows.map((row: DbDeliveryRow) => this.mapDelivery(row)),
      total: Number(countRows[0]?.count ?? 0),
      limit,
      offset,
    };
  }

  async getDeliveryStats(): Promise<GovernanceWebhookDeliveryStats> {
    await this.ensureTables();

    const rows = await prisma.$queryRawUnsafe<
      { status: string; count: number | bigint }[]
    >(
      `
        SELECT status, COUNT(*)::int AS count
        FROM governance_webhook_deliveries
        GROUP BY status
      `,
    );

    const counts: Record<string, number> = {};
    let total = 0;
    for (const row of rows) {
      const count = Number(row.count);
      counts[row.status] = count;
      total += count;
    }

    return {
      pending: counts.pending ?? 0,
      retrying: counts.retrying ?? 0,
      delivered: counts.delivered ?? 0,
      failed: counts.failed ?? 0,
      total,
    };
  }

  verifySignature(
    body: string | Buffer,
    signature: string | undefined | null,
    secret: string,
  ): boolean {
    return verifyGovernanceWebhookSignature(body, signature, secret);
  }

  buildPayload(
    eventType: GovernanceWebhookEventType,
    data: GovernanceProposalWebhookData,
    eventId = crypto.randomUUID(),
    timestamp = new Date().toISOString(),
  ): GovernanceWebhookPayload {
    return { event: eventType, eventId, timestamp, data };
  }

  private mapEndpoint(row: DbEndpointRow): GovernanceWebhookEndpoint {
    return {
      id: row.id,
      name: row.name,
      url: row.url,
      secret: row.secret,
      events: parseStoredEvents(row.events),
      active: Boolean(row.active),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  private mapDelivery(row: DbDeliveryRow): GovernanceWebhookDeliveryRecord {
    return {
      id: row.id,
      endpointId: row.endpoint_id,
      endpointUrl: row.endpoint_url,
      eventType: row.event_type,
      proposalId: row.proposal_id,
      contractId: row.contract_id,
      status: row.status as GovernanceWebhookDeliveryStatus,
      attempts: Number(row.attempts),
      maxAttempts: Number(row.max_attempts),
      responseStatus:
        row.response_status === null ? null : Number(row.response_status),
      responseBody: row.response_body,
      errorMessage: row.error_message,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      deliveredAt: row.delivered_at,
    };
  }
}

export const governanceWebhookBroadcaster =
  new GovernanceWebhookBroadcasterService();
export default governanceWebhookBroadcaster;
