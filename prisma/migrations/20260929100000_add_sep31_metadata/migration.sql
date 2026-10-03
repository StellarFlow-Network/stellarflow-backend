CREATE TABLE "Sep31TransactionMetadata" (
    "transactionId" TEXT NOT NULL,
    "sourceAsset" TEXT NOT NULL,
    "destinationAsset" TEXT NOT NULL,
    "sender" JSONB NOT NULL,
    "receiver" JSONB NOT NULL,
    "callbackUrl" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Sep31TransactionMetadata_pkey" PRIMARY KEY ("transactionId"),
    CONSTRAINT "Sep31TransactionMetadata_transactionId_fkey"
      FOREIGN KEY ("transactionId") REFERENCES "RemittanceTransaction"("id")
      ON DELETE CASCADE ON UPDATE CASCADE
);