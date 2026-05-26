import dotenv from "dotenv";
import { SorobanRpc, xdr } from "@stellar/stellar-sdk";

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
  private readonly CONTRACT_ID: string;
  private readonly NETWORK: string;
  private readonly rpcUrl: string;
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
      `🔍 Performing contract sanity check on ${this.CONTRACT_ID} (${this.NETWORK})`,
    );

    try {
      const server = new SorobanRpc.Server(this.rpcUrl, {
        allowHttp: this.NETWORK === "TESTNET",
      });

      // Attempt to read contract version (low-cost read)
      const versionResult = await this.tryGetVersion(server);

      if (versionResult.success) {
        console.log(
          `✅ Contract sanity check passed - Version: ${versionResult.version}`,
        );
        return {
          success: true,
          contractId: this.CONTRACT_ID,
          version: versionResult.version,
          isActive: true,
        };
      }

      // If version read fails, try is_active check
      const activeResult = await this.tryIsActive(server);

      if (activeResult.success) {
        console.log(
          `✅ Contract sanity check passed - Contract is active`,
        );
        return {
          success: true,
          contractId: this.CONTRACT_ID,
          isActive: activeResult.isActive,
        };
      }

      // Both checks failed
      const error = versionResult.error || activeResult.error || "Unknown error";
      console.error(`❌ Contract sanity check failed: ${error}`);
      return {
        ...result,
        error,
      };
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      console.error(`❌ Contract sanity check error: ${errorMessage}`);
      return {
        ...result,
        error: errorMessage,
      };
    }
  }

  /**
   * Try to read the contract version
   * This is a low-cost read operation that checks if the contract is responsive
   */
  private async tryGetVersion(
    server: SorobanRpc.Server,
  ): Promise<{ success: boolean; version?: string; error?: string }> {
    try {
      // Attempt to read a 'version' function from the contract
      // This is a common pattern in Soroban contracts
      const contractAddress = this.CONTRACT_ID;

      // Create a transaction to read the version
      // Note: This is a simplified approach - actual implementation depends on contract ABI
      const result = await server.getContractData(contractAddress, xdr.ScVal.scvVoid());

      // If we get a response, the contract is responsive
      // Parse the version if available
      const version = this.parseVersionFromResult(result);

      return {
        success: true,
        version: version || "unknown",
      };
    } catch (error) {
      // Version read might not be supported, try alternative method
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /**
   * Try to check if the contract is active
   * This is a fallback method if version read is not available
   */
  private async tryIsActive(
    server: SorobanRpc.Server,
  ): Promise<{ success: boolean; isActive?: boolean; error?: string }> {
    try {
      const contractAddress = this.CONTRACT_ID;

      // Try to get contract ledger data - if it exists, contract is active
      const result = await server.getContractData(
        contractAddress,
        xdr.ScVal.scvLedgerKeyContractCode(),
      );

      // If we get a response, the contract exists and is active
      return {
        success: true,
        isActive: true,
      };
    } catch (error) {
      // Contract might not exist or be inactive
      const errorMessage = error instanceof Error ? error.message : String(error);
      
      // Check if error indicates contract doesn't exist
      if (errorMessage.includes("not found") || errorMessage.includes("404")) {
        return {
          success: false,
          isActive: false,
          error: "Contract not found on ledger",
        };
      }

      return {
        success: false,
        error: errorMessage,
      };
    }
  }

  /**
   * Parse version from contract result
   * This is a helper method - actual parsing depends on contract ABI
   */
  private parseVersionFromResult(result: any): string | null {
    try {
      // Try to extract version from the result
      // This is a placeholder - actual implementation depends on contract structure
      if (result && result.val) {
        const val = result.val;
        if (typeof val === "string") {
          return val;
        }
        if (val.obj && val.obj.vec) {
          // Try to parse from array
          return val.obj.vec[0]?.toString() || null;
        }
      }
      return null;
    } catch {
      return null;
    }
  }

  /**
   * Check if the service is configured
   */
  isConfigured(): boolean {
    return !!this.CONTRACT_ID;
  }
}

export const contractSanityCheckService = new ContractSanityCheckService();
