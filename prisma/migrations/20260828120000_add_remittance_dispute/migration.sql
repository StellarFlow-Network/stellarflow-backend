-- Migration: add_remittance_dispute
-- Issue #834: Manage dispute ticket state machines when fiat payouts fail or timeout.
-- State machine: open -> investigating -> refunded | closed.
-- Tracks the dispute ticket, the notification targets (email / webhook) and the
-- manual-refund metadata set by operators through the admin endpoint.

CREATE TABLE "RemittanceDispute" (
    "id"            TEXT NOT NULL,
    "remittanceId"  TEXT NOT NULL,
    "userId"        TEXT NOT NULL,
    "status"        VARCHAR(20) NOT NULL DEFAULT 'open',
    "reason"        VARCHAR(255) NOT NULL,
    "details"       TEXT,
    "email"         TEXT,
    "webhookUrl"    TEXT,
    "refundAmount"  DECIMAL(24,10),
    "refundedById"  TEXT,
    "refundedAt"    TIMESTAMP(3),
    "resolvedById"  TEXT,
    "resolvedAt"    TIMESTAMP(3),
    "createdAt"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"     TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RemittanceDispute_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "RemittanceDispute_userId_status_createdAt_idx"
    ON "RemittanceDispute" ("userId", "status", "createdAt");
CREATE INDEX "RemittanceDispute_remittanceId_idx"
    ON "RemittanceDispute" ("remittanceId");
CREATE INDEX "RemittanceDispute_status_createdAt_idx"
    ON "RemittanceDispute" ("status", "createdAt");