import { Request, Response } from 'express';
import { VaultService } from '../services/vaultService';
import { systemicRiskService } from '../services/systemicRiskWiring';
import { AuctionPriceResponse } from '../types/vault.types';
import { logger } from '../utils/logger';

export class VaultController {
  private vaultService: VaultService;

  constructor() {
    this.vaultService = VaultService.getInstance();
  }

  async getPosition(req: Request, res: Response): Promise<void> {
    const { account_id } = req.params;

    if (!account_id) {
      res.status(400).json({
        success: false,
        error: "account_id is required",
      });
      return;
    }

    // Handle case where account_id might be an array
    const accountId = Array.isArray(account_id) ? account_id[0] : account_id;

    try {
      const position = await this.vaultService.getPosition(accountId);
      res.json({
        success: true,
        data: position,
      });
    } catch (error) {
      logger.error(`Failed to get position for account ${accountId}:`, error);
      res.status(500).json({
        success: false,
        error:
          error instanceof Error ? error.message : "Failed to fetch position",
      });
    }
  }

  /**
   * GET /auction-price?asset=XLM&elapsed=<seconds>
   *
   * Quotes the collateral liquidation Dutch auction: the price opens at
   * 110% of the oracle price and decays exponentially over a 30 minute window.
   */
  async getAuctionPrice(req: Request, res: Response): Promise<void> {
    const rawAsset = req.query.asset;
    const asset = typeof rawAsset === "string" ? rawAsset.trim() : "";

    if (!asset) {
      const body: AuctionPriceResponse = {
        success: false,
        error: "asset is required",
      };
      res.status(400).json(body);
      return;
    }

    const rawElapsed = req.query.elapsed;
    let elapsedSeconds = 0;

    if (rawElapsed !== undefined) {
      elapsedSeconds =
        typeof rawElapsed === "string" ? Number(rawElapsed) : NaN;

      if (!Number.isFinite(elapsedSeconds) || elapsedSeconds < 0) {
        const body: AuctionPriceResponse = {
          success: false,
          error: "elapsed must be a non-negative number of seconds",
        };
        res.status(400).json(body);
        return;
      }
    }

    try {
      const auctionPrice = await this.vaultService.getAuctionPrice(
        asset,
        elapsedSeconds,
      );
      const body: AuctionPriceResponse = {
        success: true,
        data: auctionPrice,
      };
      res.json(body);
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : "Failed to fetch auction price";

      // The oracle has no feed for this asset — a client error, not a crash.
      if (message.startsWith("Price not available")) {
        const body: AuctionPriceResponse = {
          success: false,
          error: `No oracle price available for asset "${asset}"`,
        };
        res.status(404).json(body);
        return;
      }

      logger.error(`Failed to get auction price for asset ${asset}:`, error);
      res.status(500).json({
        success: false,
        error: message,
      });
    }
  }

  /**
   * Issue #978 – protocol-wide multi-collateral vault systemic risk score.
   *
   * `S_risk = SUM(V_collateral) / SUM(D_debt)` across every active vault,
   * reported together with the protocol danger level (`NORMAL`, `ELEVATED`,
   * `CRITICAL`) and any parameter adjustment proposal raised by the breach.
   */
  async getSystemicRisk(_req: Request, res: Response): Promise<void> {
    try {
      const snapshot = await systemicRiskService.evaluate();
      res.json({
        success: true,
        data: snapshot,
      });
    } catch (error) {
      logger.error('Failed to evaluate systemic vault risk:', error);
      res.status(500).json({
        success: false,
        error:
          error instanceof Error
            ? error.message
            : 'Failed to evaluate systemic vault risk',
      });
    }
  }
}
