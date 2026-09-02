import { Horizon } from "@stellar/stellar-sdk";
import stellarProvider from "../../lib/stellarProvider";
import type {
  LiquidityAsset,
  LiquidityPoolConfig,
  ReserveSource,
} from "./types";

type HorizonBalance = {
  asset_type: string;
  asset_code?: string;
  asset_issuer?: string;
  balance: string;
};

export class StellarReserveSource implements ReserveSource {
  private readonly server: Horizon.Server;

  constructor(server?: Horizon.Server) {
    const network = process.env.STELLAR_NETWORK || "TESTNET";
    this.server = server ?? stellarProvider.getServer();
  }

  async getReserves(pool: LiquidityPoolConfig): Promise<[number, number]> {
    const account = await this.server.loadAccount(pool.anchorAccount);
    const balances = account.balances as HorizonBalance[];
    return pool.assets.map((asset) =>
      this.findBalance(pool.key, balances, asset),
    ) as [number, number];
  }

  private findBalance(
    poolKey: string,
    balances: HorizonBalance[],
    asset: LiquidityAsset,
  ): number {
    const line = balances.find((balance) =>
      asset.code.toUpperCase() === "XLM"
        ? balance.asset_type === "native"
        : balance.asset_code === asset.code &&
          (!asset.issuer || balance.asset_issuer === asset.issuer),
    );

    if (!line) {
      throw new Error(`Pool ${poolKey} has no ${asset.code} reserve`);
    }

    const value = Number(line.balance);
    if (!Number.isFinite(value) || value < 0) {
      throw new Error(`Pool ${poolKey} has an invalid ${asset.code} balance`);
    }
    return value;
  }
}
