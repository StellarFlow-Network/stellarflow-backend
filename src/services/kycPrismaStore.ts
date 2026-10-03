/**
 * Prisma-backed instantiation of the SEP-12 KYC store.
 *
 * Kept in its own module so `kycService.ts` stays free of the shared Prisma
 * client import and can be unit-tested in isolation.
 */

import prisma from "../lib/prisma";
import { PrismaKycStore, type KycDb } from "./kycStore";

export function createDefaultKycStore(): PrismaKycStore {
  return new PrismaKycStore(prisma as unknown as KycDb);
}
