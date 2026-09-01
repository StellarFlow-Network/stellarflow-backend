-- Issue #784: OFAC compliance screening columns on remittance transactions
ALTER TABLE "RemittanceTransaction" ALTER COLUMN "status" SET DATA TYPE VARCHAR(32);

ALTER TABLE "RemittanceTransaction" ADD COLUMN "senderPublicKey" TEXT;
ALTER TABLE "RemittanceTransaction" ADD COLUMN "recipientPublicKey" TEXT;
ALTER TABLE "RemittanceTransaction" ADD COLUMN "screeningProvider" TEXT;
ALTER TABLE "RemittanceTransaction" ADD COLUMN "screeningHits" JSONB;
ALTER TABLE "RemittanceTransaction" ADD COLUMN "payoutHalted" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "RemittanceTransaction" ADD COLUMN "payoutRelayedAt" TIMESTAMP(3);
ALTER TABLE "RemittanceTransaction" ADD COLUMN "screenedAt" TIMESTAMP(3);

CREATE INDEX "RemittanceTransaction_senderPublicKey_idx" ON "RemittanceTransaction" ("senderPublicKey");
CREATE INDEX "RemittanceTransaction_recipientPublicKey_idx" ON "RemittanceTransaction" ("recipientPublicKey");
