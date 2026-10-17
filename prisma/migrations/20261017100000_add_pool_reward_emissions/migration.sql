CREATE TABLE "PoolRewardEmission" (
    "id" TEXT NOT NULL,
    "poolId" VARCHAR(50) NOT NULL,
    "tokenCode" VARCHAR(16) NOT NULL,
    "amountPerSecond" DECIMAL(30,12) NOT NULL,
    "tokenPriceUsd" DECIMAL(30,10) NOT NULL,
    "startsAt" TIMESTAMP(3) NOT NULL,
    "endsAt" TIMESTAMP(3),

    CONSTRAINT "PoolRewardEmission_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "PoolRewardEmission_poolId_startsAt_endsAt_idx"
    ON "PoolRewardEmission"("poolId", "startsAt", "endsAt");
