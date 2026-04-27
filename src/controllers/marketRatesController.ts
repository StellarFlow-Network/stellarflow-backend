import { Request, Response } from "express";
import { MarketRateService } from "../services/marketRate";

const marketRateService = new MarketRateService();

export const getRate = async (req: Request, res: Response) => {
  try {
    const { currency } = req.params;
    if (!currency || typeof currency !== "string") {
      return res.status(400).json({
        success: false,
        error: "Currency parameter is required and must be a string",
      });
    }
    const result = await marketRateService.getRate(currency);
    if (result.success) {
      res.json({
        success: true,
        data: result.data,
      });
    } else {
      res.status(404).json({
        success: false,
        error: result.error,
      });
    }
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : "Internal server error",
    });
  }
};

export const getAllRates = async (req: Request, res: Response) => {
  try {
    const results = await marketRateService.getAllRates();
    const rates = results
      .filter((result) => result.success)
      .map((result) => result.data);
    res.json({
      success: true,
      data: rates,
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : "Internal server error",
    });
  }
};
