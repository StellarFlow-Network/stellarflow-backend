import { Request, Response } from "express";
import { MarketRateService } from "../services/marketRate/marketRateService";
import { DerivedAssetService } from "../services/derivedAssetService";

const marketRateService = new MarketRateService();
const derivedAssetService = new DerivedAssetService(marketRateService);

/**
 * Get synthetic cross-rate between two currencies
 */
export const getDerivedRate = async (req: Request, res: Response) => {
  try {
    const { base, quote } = req.params;

    if (!base || !quote) {
      return res.status(400).json({
        success: false,
        error: "Both base and quote currency codes are required",
      });
    }

    const result = await derivedAssetService.getDerivedRate(
      base as string,
      quote as string,
    );

    if (result.success) {
      return res.json(result);
    } else {
      return res.status(500).json(result);
    }
  } catch (error) {
    console.error("Error in getDerivedRate controller:", error);
    return res.status(500).json({
      success: false,
      error:
        error instanceof Error
          ? error.message
          : "Failed to calculate derived rate",
    });
  }
};

/**
 * Specifically get NGN/GHS synthetic rate
 */
export const getNGNGHSRate = async (req: Request, res: Response) => {
  try {
    const result = await derivedAssetService.getNGNGHSRate();

    if (result.success) {
      return res.json(result);
    } else {
      return res.status(500).json(result);
    }
  } catch (error) {
    console.error("Error in getNGNGHSRate controller:", error);
    return res.status(500).json({
      success: false,
      error:
        error instanceof Error
          ? error.message
          : "Failed to calculate NGN/GHS rate",
    });
  }
};
