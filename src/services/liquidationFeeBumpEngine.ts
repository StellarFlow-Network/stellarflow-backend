/** The keeper may pay at most ten percent of the liquidation profit in fees. */
export const MAX_LIQUIDATION_FEE_BPS = 1_000;
/** A replacement transaction must outbid the observed competitor by 25%. */
export const COMPETITOR_FEE_MULTIPLIER_BPS = 12_500;

export interface LiquidationFeeBumpInput {
  competingFeeStroops: number;
  estimatedProfitStroops: number;
  baseFeeStroops?: number;
}

export class LiquidationFeeBumpEngine {
  quote(input: LiquidationFeeBumpInput): number {
    if (!Number.isSafeInteger(input.competingFeeStroops) || input.competingFeeStroops < 0) {
      throw new Error("competing fee must be a non-negative integer");
    }
    if (!Number.isSafeInteger(input.estimatedProfitStroops) || input.estimatedProfitStroops <= 0) {
      throw new Error("estimated liquidation profit must be a positive integer");
    }

    const cap = Math.floor(
      (input.estimatedProfitStroops * MAX_LIQUIDATION_FEE_BPS) / 10_000,
    );
    const replacement = Math.ceil(
      (input.competingFeeStroops * COMPETITOR_FEE_MULTIPLIER_BPS) / 10_000,
    );
    const baseFee = input.baseFeeStroops ?? 0;
    if (!Number.isSafeInteger(baseFee) || baseFee < 0) {
      throw new Error("base fee must be a non-negative integer");
    }
    return Math.min(Math.max(baseFee, replacement), cap);
  }
}
