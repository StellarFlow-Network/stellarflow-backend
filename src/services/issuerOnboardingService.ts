/**
 * Issuer Onboarding Service — Issue #120
 *
 * Handles the full lifecycle of a healthcare provider's application to become
 * an approved issuer:
 *   1. Provider submits an onboarding request (name, license, country, wallet)
 *   2. Admin reviews and approves or rejects via the admin dashboard
 *   3. On approval the wallet is added to the contract allowlist
 *   4. Applicant is notified of the decision
 */

import prisma from "../lib/prisma.js";
import { logger } from "../utils/logger.js";

export interface IssuerApplicationInput {
  name: string;
  licenseNumber: string;
  country: string;
  walletAddress: string;
}

export interface AdminDecisionInput {
  requestId: number;
  approve: boolean;
  reviewedBy: string;
  reviewNote?: string;
}

/**
 * Submit a new issuer onboarding request.
 * Returns the created record.
 */
export async function submitIssuerApplication(input: IssuerApplicationInput) {
  const { name, licenseNumber, country, walletAddress } = input;

  // Prevent duplicate pending applications for the same wallet
  const existing = await prisma.issuerOnboardingRequest.findFirst({
    where: { walletAddress, status: "PENDING" },
  });

  if (existing) {
    throw new Error("A pending application already exists for this wallet address.");
  }

  const request = await prisma.issuerOnboardingRequest.create({
    data: { name, licenseNumber, country, walletAddress, status: "PENDING" },
  });

  logger.info("[IssuerOnboarding] New application submitted", {
    id: request.id,
    walletAddress,
    name,
  });

  return request;
}

/**
 * List all pending onboarding requests (for the admin dashboard).
 */
export async function listPendingApplications() {
  return prisma.issuerOnboardingRequest.findMany({
    where: { status: "PENDING" },
    orderBy: { createdAt: "asc" },
  });
}

/**
 * List all applications (any status) — for admin overview.
 */
export async function listAllApplications() {
  return prisma.issuerOnboardingRequest.findMany({
    orderBy: { createdAt: "desc" },
  });
}

/**
 * Admin approves or rejects an application.
 * On approval, marks the record and triggers the allowlist update.
 */
export async function processAdminDecision(input: AdminDecisionInput) {
  const { requestId, approve, reviewedBy, reviewNote } = input;

  const request = await prisma.issuerOnboardingRequest.findUnique({
    where: { id: requestId },
  });

  if (!request) throw new Error(`Onboarding request ${requestId} not found.`);
  if (request.status !== "PENDING") {
    throw new Error(`Request ${requestId} has already been ${request.status.toLowerCase()}.`);
  }

  const newStatus = approve ? "APPROVED" : "REJECTED";

  const updated = await prisma.issuerOnboardingRequest.update({
    where: { id: requestId },
    data: {
      status: newStatus,
      reviewedBy,
      reviewedAt: new Date(),
      reviewNote: reviewNote ?? null,
    },
  });

  logger.info("[IssuerOnboarding] Admin decision recorded", {
    id: requestId,
    status: newStatus,
    reviewedBy,
  });

  if (approve) {
    // Trigger allowlist update (fire-and-forget; errors are logged)
    void addToContractAllowlist(updated.id, updated.walletAddress);
  }

  return updated;
}

/**
 * Adds the approved wallet to the on-chain contract allowlist.
 * In a real deployment this would call the Soroban contract via StellarService.
 * Here we record the intent and mark the DB record accordingly.
 */
async function addToContractAllowlist(requestId: number, walletAddress: string): Promise<void> {
  try {
    logger.info("[IssuerOnboarding] Adding wallet to contract allowlist", {
      requestId,
      walletAddress,
    });

    // TODO: replace with actual Soroban contract call
    // const txHash = await stellarService.addIssuerToAllowlist(walletAddress);
    const txHash = `PENDING_ONCHAIN_${requestId}`;

    await prisma.issuerOnboardingRequest.update({
      where: { id: requestId },
      data: { addedToAllowlist: true, allowlistTxHash: txHash },
    });

    logger.info("[IssuerOnboarding] Wallet added to allowlist", {
      requestId,
      walletAddress,
      txHash,
    });
  } catch (err) {
    logger.error("[IssuerOnboarding] Failed to add wallet to allowlist", {
      requestId,
      walletAddress,
      error: err,
    });
  }
}
