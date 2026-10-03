/**
 * Adapter that feeds the systemic risk engine (Issue #978) from the existing
 * per-account vault service.
 *
 * The backend does not yet persist a vault registry, so the set of vaults that
 * participate in the protocol-wide index is configured explicitly through
 * `SYSTEMIC_RISK_VAULT_ACCOUNTS` (comma-separated Stellar account ids). Each
 * account is valued through the shared `VaultService`, which already resolves
 * oracle prices. Accounts that cannot be valued are excluded and logged rather
 * than poisoning the index with a partial valuation.
 */
import { logger } from "../utils/logger";
import { VaultService } from "./vaultService";
import type { Collateral, Debt } from "../types/vault.types";
import type {
  SystemicRiskAssetPosition,
  SystemicRiskSource,
  SystemicRiskVault,
} from "./systemicRiskService";

export const SYSTEMIC_RISK_ACCOUNTS_ENV = "SYSTEMIC_RISK_VAULT_ACCOUNTS";

export function systemicRiskAccountIdsFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  return (env[SYSTEMIC_RISK_ACCOUNTS_ENV] ?? "")
    .split(",")
    .map((accountId) => accountId.trim())
    .filter((accountId) => accountId.length > 0);
}

function toPosition(position: Collateral | Debt): SystemicRiskAssetPosition {
  return {
    asset: position.asset,
    amount: position.amount,
    priceUsd: position.price,
  };
}

export class VaultServiceSystemicRiskSource implements SystemicRiskSource {
  constructor(
    private readonly vaultService: Pick<VaultService, "getPosition">,
    private readonly accountIds: string[] = [],
  ) {}

  async listActiveVaults(): Promise<SystemicRiskVault[]> {
    const vaults: SystemicRiskVault[] = [];

    for (const accountId of this.accountIds) {
      try {
        const position = await this.vaultService.getPosition(accountId);
        vaults.push({
          vaultId: accountId,
          owner: accountId,
          active: true,
          collateral: position.collateralBreakdown.map(toPosition),
          debt: position.debtBreakdown.map(toPosition),
        });
      } catch (error) {
        logger.warn(
          `[SystemicRiskSource] Excluding vault ${accountId} from the systemic risk index:`,
          error,
        );
      }
    }

    return vaults;
  }
}
