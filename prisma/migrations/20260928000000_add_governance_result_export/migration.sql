-- Issue #1019: store the IPFS content hash (CID) of the immutable governance
-- proposal result snapshot produced by the export worker.
ALTER TABLE "GovernanceProposal" ADD COLUMN "resultExportCid" TEXT;
ALTER TABLE "GovernanceProposal" ADD COLUMN "resultExportContentHash" TEXT;
ALTER TABLE "GovernanceProposal" ADD COLUMN "resultExportedAt" TIMESTAMP(3);
ALTER TABLE "GovernanceProposal" ADD COLUMN "resultExportAttempts" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "GovernanceProposal" ADD COLUMN "resultExportError" TEXT;

CREATE INDEX "GovernanceProposal_status_resultExportCid_idx" ON "GovernanceProposal"("status", "resultExportCid");
