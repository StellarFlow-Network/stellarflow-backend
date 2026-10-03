/**
 * Application-wide SEP-12 KYC service instance, wired to the shared Prisma
 * client and the configured encryption key.
 */

import { KycService } from "./kycService";
import { createDefaultKycStore } from "./kycPrismaStore";

export const kycService = new KycService({
  store: createDefaultKycStore(),
});

export { KycService };
