-- AlterTable
ALTER TABLE "Relayer" ADD COLUMN "whitelistedIps" TEXT[] DEFAULT ARRAY[]::TEXT[];
