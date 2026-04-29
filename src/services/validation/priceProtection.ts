export const PRICE_REVIEW_WINDOW_MS = 5 * 60 * 1000;
export const PRICE_CHANGE_THRESHOLD = 0.15;

export interface PriceMovementEvaluation {
  isAnomalous: boolean;
  changePercent: number;
  reason?: string | undefined;
}

export function evaluatePriceMovement(params: {
  currentRate: number;
  baselineRate: number;
  currency: string;
  threshold?: number;
}): PriceMovementEvaluation {
  const threshold = params.threshold ?? PRICE_CHANGE_THRESHOLD;

  if (params.baselineRate <= 0 || params.currentRate <= 0) {
    return {
      isAnomalous: false,
      changePercent: 0,
    };
  }

  const changePercent =
    (Math.abs(params.currentRate - params.baselineRate) / params.baselineRate) *
    100;
  const isAnomalous = changePercent > threshold * 100;

  return isAnomalous
    ? {
        isAnomalous,
        changePercent,
        reason: `${params.currency} moved ${changePercent.toFixed(2)}% within 5 minutes, exceeding the 15% manual review threshold.`,
      }
    : {
        isAnomalous,
        changePercent,
      };
}
