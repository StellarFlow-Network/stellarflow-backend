import { sorobanTransactionSimulationService } from "./sorobanTransactionSimulationService";
import { logger } from "../utils/logger";

export interface ProposalSimulationResult {
  allowed: boolean;
  status: "success" | "error" | "restore_required";
  error?: string;
  latestLedger?: number;
  instructions?: string;
  memoryBytes?: string;
}

export class GovernanceTimelockSimulationGuard {
  /**
   * Simulates a timelocked governance proposal transaction against the current
   * mainnet/testnet Soroban state fork before execution.
   * 
   * Blocks execution in production / deployment if the dry-run simulation encounters
   * any errors or requires restorative steps that fail safety invariants.
   */
  async simulateProposalExecution(transactionXdr: string): Promise<ProposalSimulationResult> {
    if (!transactionXdr || typeof transactionXdr !== "string" || transactionXdr.trim().length === 0) {
      logger.error("[GovernanceTimelockSimulationGuard] Invalid or empty transaction XDR provided for simulation");
      return {
        allowed: false,
        status: "error",
        error: "Invalid or empty transaction XDR provided for simulation.",
      };
    }

    try {
      const simulation = await sorobanTransactionSimulationService.simulate(transactionXdr);

      if (simulation.status === "error") {
        logger.error("[GovernanceTimelockSimulationGuard] Timelocked governance proposal simulation FAILED", {
          error: simulation.error,
          latestLedger: simulation.latestLedger,
        });
        return {
          allowed: false,
          status: "error",
          error: simulation.error ?? "Soroban simulation returned an error status.",
          latestLedger: simulation.latestLedger,
          instructions: simulation.instructions,
          memoryBytes: simulation.memoryBytes,
        };
      }

      logger.info("[GovernanceTimelockSimulationGuard] Timelocked governance proposal simulation PASSED", {
        status: simulation.status,
        latestLedger: simulation.latestLedger,
        instructions: simulation.instructions,
      });

      return {
        allowed: true,
        status: simulation.status,
        latestLedger: simulation.latestLedger,
        instructions: simulation.instructions,
        memoryBytes: simulation.memoryBytes,
      };
    } catch (error: any) {
      logger.error("[GovernanceTimelockSimulationGuard] Simulation exception encountered", {
        message: error?.message,
      });
      return {
        allowed: false,
        status: "error",
        error: error?.message ?? "Unknown simulation exception",
      };
    }
  }
}

export const governanceTimelockSimulationGuard = new GovernanceTimelockSimulationGuard();
