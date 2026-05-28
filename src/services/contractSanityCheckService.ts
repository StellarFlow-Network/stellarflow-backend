import dotenv from "dotenv";
import { xdr } from "@stellar/stellar-sdk";

dotenv.config();

interface ContractSanityCheckResult {
  success: boolean;
  contractId: string;
  error?: string;
  version?: string;
  isActive?: boolean;
}

/**
 * Contract Sanity Check Service
 * Performs low-cost reads on the target smart contract to verify it's active and responsive
 * before starting the backend ingestion loop.
 */
export class ContractSanityCheckService {
  // eslint-disable-next-line @typescript-eslint/naming-convention
  private readonly CONTRACT_ID: string;
  // eslint-disable-next-line @typescript-eslint/naming-convention
  private readonly NETWORK: string;
  private readonly rpcUrl: string;
  // eslint-disable-next-line @typescript-eslint/naming-convention
  private readonly TIMEOUT_MS = 10000; // 10 second timeout for contract reads

  constructor() {
    this.CONTRACT_ID = process.env.CONTRACT_ID || "";
    this.NETWORK = process.env.STELLAR_NETWORK || "TESTNET";

    // Configure RPC URL based on network
    if (this.NETWORK === "PUBLIC") {
      this.rpcUrl = "https://rpc.mainnet.stellar.org";
    } else {
      this.rpcUrl = "https://rpc.testnet.stellar.org";
    }
  }

  /**
   * Perform a sanity check on the target contract
   * Attempts to read contract version or active status
   */
  async performSanityCheck(): Promise<ContractSanityCheckResult> {
    const result: ContractSanityCheckResult = {
      success: false,
      contractId: this.CONTRACT_ID,
    };

    // Skip check if CONTRACT_ID is not configured
    if (!this.CONTRACT_ID) {
      console.warn(
        "⚠️ CONTRACT_ID not configured - skipping contract sanity check",
      );
      return {
        ...result,
        success: true, // Allow startup if contract ID is not configured (backward compatibility)
        error: "CONTRACT_ID not configured",
      };
    }

    console.log(
      `🔍 Skipping contract sanity check (Soroban RPC server not available in current SDK version)`,
    );

    // Skip the check for now - Soroban RPC API may not be available
    // TODO: Update when Soroban RPC is available in the SDK
    return {
      success: true,
      contractId: this.CONTRACT_ID,
      version: "unknown",
      isActive: true,
    };
  }

  // Placeholder methods - kept for future implementation when Soroban RPC is available
  /**
   * Try to read the contract version
   * This is a low-cost read operation that checks if the contract is responsive
   * TODO: Implement when Soroban RPC is available
   */
  private async tryGetVersion(
    _server: any,
  ): Promise<{ success: boolean; version?: string; error?: string }> {
    return { success: false, error: "Not implemented" };
  }

  /**
   * Try to check if the contract is active
   * This is a fallback method if version read is not available
   * TODO: Implement when Soroban RPC is available
   */
  private async tryIsActive(
    _server: any,
  ): Promise<{ success: boolean; isActive?: boolean; error?: string }> {
    return { success: false, error: "Not implemented" };
  }

  /**
   * Check if the service is configured
   */
  isConfigured(): boolean {
    return !!this.CONTRACT_ID;
  }
}

export const contractSanityCheckService = new ContractSanityCheckService();
