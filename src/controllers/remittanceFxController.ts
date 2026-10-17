import { Request, Response } from "express";
import { sendApiError } from "../lib/apiError";
import { RemittanceFxEngine } from "../services/remittance/fxEngine";
import { Sep38QuoteExpirationEngine } from "../services/sep38QuoteExpirationEngine";

const fxEngine = new RemittanceFxEngine();
const quoteExpirationEngine = new Sep38QuoteExpirationEngine();

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

export const refreshSep38Quote = async (req: Request, res: Response) => {
  try {
    const { quoteId, sourceCurrency, targetCurrency, sourceAmount, routeLiquidityScore } = {
      ...req.query,
      ...req.body,
    } as Record<string, unknown>;

    if (!quoteId || typeof quoteId !== "string") {
      return sendApiError(res, 400, "BAD_REQUEST", "quoteId is required");
    }

    const parsedAmount = sourceAmount !== undefined ? Number(sourceAmount) : undefined;
    if (parsedAmount !== undefined && (!Number.isFinite(parsedAmount) || parsedAmount <= 0)) {
      return sendApiError(res, 400, "BAD_REQUEST", "sourceAmount must be a valid positive number");
    }

    const parsedLiquidity = routeLiquidityScore !== undefined ? Number(routeLiquidityScore) : undefined;
    if (parsedLiquidity !== undefined && (!Number.isFinite(parsedLiquidity) || parsedLiquidity < 0 || parsedLiquidity > 1)) {
      return sendApiError(res, 400, "BAD_REQUEST", "routeLiquidityScore must be between 0 and 1");
    }

    const refreshed = await quoteExpirationEngine.refreshQuote({
      quoteId,
      sourceCurrency: typeof sourceCurrency === "string" ? sourceCurrency : undefined,
      targetCurrency: typeof targetCurrency === "string" ? targetCurrency : undefined,
      sourceAmount: parsedAmount,
      routeLiquidityScore: parsedLiquidity,
    });

    res.json({
      success: true,
      data: refreshed,
    });
  } catch (error) {
    const msg = error instanceof Error ? error.message : "Failed to refresh SEP-38 quote";
    const status = /not found/i.test(msg) ? 404 : 500;
    sendApiError(res, status, status === 404 ? "NOT_FOUND" : "INTERNAL_SERVER_ERROR", msg);
  }
};
