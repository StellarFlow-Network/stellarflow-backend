import { Request, Response } from "express";
import { orderDepthAggregatorService } from "../services/orderDepthAggregatorService";
import { sendApiError } from "../lib/apiError";
import { treasuryDiversificationService } from "../services/treasuryDiversificationService";

export async function getOrderDepth(req: Request, res: Response) {
  const { market, tickSize } = req.query;

  if (typeof market !== "string" || typeof tickSize !== "string") {
    return sendApiError(res, 400, "VALIDATION_ERROR", "market and tickSize are required");
  }

  try {
    const cachedDepth = await orderDepthAggregatorService.getCachedDepth(market);

    if (cachedDepth) {
      res.json({ success: true, data: cachedDepth });
      return;
    }

    const depth = await orderDepthAggregatorService.getDepth(market, tickSize);
    await orderDepthAggregatorService.updateDepth(market, tickSize);
    res.json({ success: true, data: depth });
  } catch (error) {
    sendApiError(res, 500, "INTERNAL_ERROR", "Unable to load order depth");
  }
}

export async function simulateTreasuryDiversificationSwap(req: Request, res: Response) {
  const { market, tickSize, assets, totalNotional, maxImpactPercent, twapIntervalSeconds, twapHorizonSeconds, gasPriceGwei, gasLimitPerOrder } = req.body ?? {};

  if (
    typeof market !== "string" ||
    typeof tickSize !== "string" ||
    !Array.isArray(assets) ||
    assets.length === 0
  ) {
    return sendApiError(
      res,
      400,
      "VALIDATION_ERROR",
      "market, tickSize, and a non-empty assets array are required"
    );
  }

  const notional = Number(totalNotional);
  if (!Number.isFinite(notional) || notional <= 0) {
    return sendApiError(res, 400, "VALIDATION_ERROR", "totalNotional must be a positive number");
  }

  const maxImpact =
    maxImpactPercent === undefined ? 0.5 : Number(maxImpactPercent);
  if (!Number.isFinite(maxImpact) || maxImpact <= 0) {
    return sendApiError(res, 400, "VALIDATION_ERROR", "maxImpactPercent must be a positive number");
  }

  const interval = twapIntervalSeconds === undefined ? 60 : Number(twapIntervalSeconds);
  const horizon = twapHorizonSeconds === undefined ? 3600 : Number(twapHorizonSeconds);
  if (!Number.isFinite(interval) || interval <= 0) {
    return sendApiError(res, 400, "VALIDATION_ERROR", "twapIntervalSeconds must be a positive number");
  }
  if (!Number.isFinite(horizon) || horizon <= 0) {
    return sendApiError(res, 400, "VALIDATION_ERROR", "twapHorizonSeconds must be a positive number");
  }

  const gasPrice = gasPriceGwei === undefined ? 0 : Number(gasPriceGwei);
  if (!Number.isFinite(gasPrice) || gasPrice < 0) {
    return sendApiError(res, 400, "VALIDATION_ERROR", "gasPriceGwei must be a non-negative number");
  }

  const gasLimit =
    gasLimitPerOrder === undefined ? 0 : Number(gasLimitPerOrder);
  if (!Number.isFinite(gasLimit) || gasLimit < 0) {
    return sendApiError(res, 400, "VALIDATION_ERROR", "gasLimitPerOrder must be a non-negative number");
  }

  try {
    const depth = await orderDepthAggregatorService.getDepth(market, tickSize);

    const simulation = treasuryDiversificationService.simulate({
      market,
      tickSize,
      depth,
      assets,
      totalNotional: notional,
      maxImpactPercent: maxImpact,
      twapIntervalSeconds: interval,
      twapHorizonSeconds: horizon,
      gasPriceGwei: gasPrice,
      gasLimitPerOrder: gasLimit,
    });

    res.json({ success: true, data: simulation });
  } catch (error) {
    sendApiError(res, 500, "INTERNAL_ERROR", "Unable to simulate treasury diversification swap");
  }
}
