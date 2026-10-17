-- SEP-38 quote expiration & refresh engine
-- Creates the quote table used by the background expiration worker and
-- the client auto-refresh route.

CREATE TABLE "sep38_quotes" (
    "id" TEXT NOT NULL,
    "quote_id" TEXT NOT NULL,
    "source_currency" TEXT NOT NULL,
    "target_currency" TEXT NOT NULL,
    "source_amount" TEXT NOT NULL,
    "rate" TEXT NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "locked_buyer_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "sep38_quotes_pk" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "sep38_quotes_quote_id_key" ON "sep38_quotes"("quote_id");

CREATE INDEX "sep38_quotes_status_expires_at_idx" ON "sep38_quotes"("status", "expires_at");

CREATE INDEX "sep38_quotes_source_target_idx" ON "sep38_quotes"("source_currency", "target_currency");
