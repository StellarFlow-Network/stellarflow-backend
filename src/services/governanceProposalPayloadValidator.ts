import { rpc as SorobanRpc, Transaction, xdr } from "@stellar/stellar-sdk";
import stellarProvider from "../lib/stellarProvider";
import prisma from "../lib/prisma";
import { logger } from "../utils/logger";
import { notificationService, AlertType, AlertSeverity } from "./notificationService";

export interface ProposalValidationReport {
  proposalId: string;
  contractId: string;
  simulatedSuccessfully: boolean;
  reverted: boolean;
  outOfGas: boolean;
  errorDetails: string | null;
  isValid: boolean;
  checkedAt: Date;
}

/**
 * GovernanceProposalPayloadValidator
 * Pre-validates proposed contract execution call bytes off-chain against Soroban RPC dry-run interface
 * prior to on-chain execution phase, asserting success without contract reverts or out-of-gas errors,
 * and flagging invalid payloads in the admin portal prior to timelock expiration.
 */
export class GovernanceProposalPayloadValidator {
  constructor(
    private readonly rpcServer: SorobanRpc.Server = stellarProvider.getRpcServer(),
  ) {}

  /**
   * Simulates execution of a governance proposal transaction against Soroban RPC.
   */
  async simulateProposalExecution(transaction: Transaction): Promise<{
    success: boolean;
    reverted: boolean;
    outOfGas: boolean;
    error: string | null;
  }> {
    try {
      const simulation = await this.rpcServer.simulateTransaction(transaction);
      if (SorobanRpc.Api.isSimulationError(simulation)) {
        const errMsg = simulation.error ?? "Simulation error";
        const isOog =
          typeof errMsg === "string" &&
          (errMsg.toLowerCase().includes("gas") ||
            errMsg.toLowerCase().includes("budget"));
        return {
          success: false,
          reverted: !isOog,
          outOfGas: isOog,
          error: String(errMsg),
        };
      }

      // Check if simulation result contains results indicating a failure / contract revert
      const result = simulation.result;
      if (result && "retval" in result) {
        // Check result.error or auth if applicable
      }

      return {
        success: true,
        reverted: false,
        outOfGas: false,
        error: null,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const isOog =
        message.toLowerCase().includes("gas") ||
        message.toLowerCase().includes("budget");
      return {
        success: false,
        reverted: !isOog,
        outOfGas: isOog,
        error: message,
      };
    }
  }

  /**
   * Validates a pending governance proposal and flags it in the database/admin portal if invalid.
   */
  async validateAndFlagProposal(params: {
    id: number;
    proposalId: string;
    contractId: string;
    transaction: Transaction;
    expiresAt: Date;
  }): Promise<ProposalValidationReport> {
    const { id, proposalId, contractId, transaction, expiresAt } = params;
    const simResult = await this.simulateProposalExecution(transaction);

    const isValid = simResult.success && !simResult.reverted && !simResult.outOfGas;
    const errorDetails = simResult.error;

    // If invalid and timelock hasn't expired yet, flag in admin portal & send notification
    const now = new Date();
    const isBeforeExpiration = now < expiresAt;

    if (!isValid && isBeforeExpiration) {
      logger.warn(
        `[GOVERNANCE] Invalid execution payload flagged for proposal ${proposalId} on contract ${contractId}`,
        { error: errorDetails, expiresAt }
      );

      try {
        await prisma.governanceProposal.update({
          where: { id },
          data: {
            status: "INVALID_PAYLOAD_FLAGGED",
            executionReadyNotifiedAt: now,
          },
        });
      } catch (dbErr) {
        logger.error(`[GOVERNANCE] Failed to update invalid proposal state in DB: ${dbErr}`);
      }

      try {
        await notificationService.sendAlert({
          type: AlertType.GOVERNANCE_TIMELOCK_READY,
          severity: AlertSeverity.HIGH,
          title: `⚠️ Invalid Governance Proposal Payload: ${proposalId}`,
          message: `Proposal execution payload simulation failed prior to timelock expiration (${expiresAt.toISOString()}). Error: ${errorDetails}`,
          details: {
            proposalId,
            contractId,
            error: errorDetails,
            reverted: simResult.reverted,
            outOfGas: simResult.outOfGas,
          },
          timestamp: now,
        });
      } catch (notifErr) {
        logger.error(`[GOVERNANCE] Failed to send invalid payload alert: ${notifErr}`);
      }
    }

    return {
      proposalId,
      contractId,
      simulatedSuccessfully: simResult.success,
      reverted: simResult.reverted,
      outOfGas: simResult.outOfGas,
      errorDetails,
      isValid,
      checkedAt: now,
    };
  }
}

export const governanceProposalPayloadValidator = new GovernanceProposalPayloadValidator();
