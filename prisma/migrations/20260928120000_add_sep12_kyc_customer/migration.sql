-- Issue #990: SEP-12 Customer Information Transfer (KYC) store.
--
-- KYC payloads are encrypted at rest with AES-256-GCM (see
-- src/services/kycEncryption.ts); only ciphertext is persisted in
-- "encryptedPayload" and forwarded to the configured anchor.

CREATE TABLE "KycCustomer" (
    "id" TEXT NOT NULL,
    "account" VARCHAR(64),
    "memo" TEXT,
    "memoType" VARCHAR(16),
    "status" VARCHAR(16) NOT NULL,
    "message" TEXT,
    "encryptedPayload" TEXT NOT NULL,
    "fieldsRequested" JSONB,
    "anchorReference" TEXT,
    "provider" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "KycCustomer_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "KycCustomer_account_memoType_memo_key"
    ON "KycCustomer"("account", "memoType", "memo");

CREATE INDEX "KycCustomer_status_createdAt_idx"
    ON "KycCustomer"("status", "createdAt");

CREATE INDEX "KycCustomer_account_idx"
    ON "KycCustomer"("account");
