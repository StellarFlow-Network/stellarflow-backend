import { Request, Response } from "express";
import { sendApiError } from "../lib/apiError";
import { RemittanceFxEngine } from "../services/remittance/fxEngine";

const fxEngine = new RemittanceFxEngine();

export const calculateFxQuote = async (req: Request, res: Response) => {
  try {
    const { sourceCurrency, targetCurrency, sourceAmount, routeLiquidityScore } = req.body ?? req.query;

    if (!sourceCurrency || typeof sourceCurrency !== "string") {
      return sendApiError(res, 400, "BAD_REQUEST", "sourceCurrency is required");
    }
    if (!targetCurrency || typeof targetCurrency !== "string") {
      return sendApiError(res, 400, "BAD_REQUEST", "targetCurrency is required");
    }

    const parsedAmount = Number(sourceAmount);
    if (!Number.isFinite(parsedAmount) || parsedAmount <= 0) {
      return sendApiError(res, 400, "BAD_REQUEST", "sourceAmount must be a valid positive number");
    }

    const parsedLiquidity = routeLiquidityScore !== undefined ? Number(routeLiquidityScore) : undefined;
    if (parsedLiquidity !== undefined && (!Number.isFinite(parsedLiquidity) || parsedLiquidity < 0 || parsedLiquidity > 1)) {
      return sendApiError(res, 400, "BAD_REQUEST", "routeLiquidityScore must be between 0 and 1");
    }

    const quote = await fxEngine.getQuote({
      sourceCurrency: sourceCurrency.toUpperCase(),
      targetCurrency: targetCurrency.toUpperCase(),
      sourceAmount: parsedAmount,
      routeLiquidityScore: parsedLiquidity,
    });

    res.json({
      success: true,
      data: quote,
    });
  } catch (error) {
    const msg = error instanceof Error ? error.message : "Failed to calculate FX quote";
    sendApiError(res, 500, "INTERNAL_SERVER_ERROR", msg);
  }
};
