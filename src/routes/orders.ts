import { Request, Response, Router } from "express";
import { getOrderDepth } from "../controllers/orderDepthController";

const router = Router();

router.get("/depth", getOrderDepth);

interface SwapAsset {
  symbol: string;
  amount: number;
  priceUsd: number;
  liquidityUsd: number;
}

interface TwapSlice {
  sliceIndex: number;
  assetSymbol: string;
  amount: number;
  notionalUsd: number;
  estimatedImpactPct: number;
  scheduledAt: string;
}

interface GasBreakdown {
  approvalGas: number;
  swapGasPerSlice: number;
  totalSwapGas: number;
  totalGas: number;
  estimatedGasCostUsd: number;
}

interface SimulationResult {
  totalNotionalUsd: number;
  sliceCount: number;
  intervalSeconds: number;
  maxImpactPct: number;
  withinImpactTarget: boolean;
  schedule: TwapSlice[];
  gas: GasBreakdown;
}

const IMPACT_TARGET_PCT = 0.5;
const GAS_PRICE_GWEI = 25;
const ETH_PRICE_USD = 3200;
const APPROVAL_GAS = 46000;
const SWAP_GAS_PER_SLICE = 185000;

function estimateImpactPct(notionalUsd: number, liquidityUsd: number): number {
  if (liquidityUsd <= 0) {
    return Number.POSITIVE_INFINITY;
  }
  return (notionalUsd / liquidityUsd) * 100;
}

function computeSliceCount(assets: SwapAsset[]): number {
  let slices = 1;
  for (const asset of assets) {
    const fullImpact = estimateImpactPct(asset.amount * asset.priceUsd, asset.liquidityUsd);
    if (fullImpact > IMPACT_TARGET_PCT) {
      slices = Math.max(slices, Math.ceil(fullImpact / IMPACT_TARGET_PCT));
    }
  }
  return slices;
}

function buildSchedule(assets: SwapAsset[], sliceCount: number, intervalSeconds: number): TwapSlice[] {
  const schedule: TwapSlice[] = [];
  const start = Date.now();
  let sliceIndex = 0;
  for (const asset of assets) {
    const notionalUsd = asset.amount * asset.priceUsd;
    const perSliceAmount = asset.amount / sliceCount;
    const perSliceNotional = notionalUsd / sliceCount;
    for (let i = 0; i < sliceCount; i++) {
      schedule.push({
        sliceIndex,
        assetSymbol: asset.symbol,
        amount: perSliceAmount,
        notionalUsd: perSliceNotional,
        estimatedImpactPct: estimateImpactPct(perSliceNotional, asset.liquidityUsd),
        scheduledAt: new Date(start + sliceIndex * intervalSeconds * 1000).toISOString(),
      });
      sliceIndex++;
    }
  }
  return schedule;
}

function buildGasBreakdown(sliceCount: number, assetCount: number): GasBreakdown {
  const approvalGas = APPROVAL_GAS * assetCount;
  const totalSwapGas = SWAP_GAS_PER_SLICE * sliceCount;
  const totalGas = approvalGas + totalSwapGas;
  const gasCostEth = (totalGas * GAS_PRICE_GWEI) / 1e9;
  return {
    approvalGas,
    swapGasPerSlice: SWAP_GAS_PER_SLICE,
    totalSwapGas,
    totalGas,
    estimatedGasCostUsd: gasCostEth * ETH_PRICE_USD,
  };
}

export const simulateDiversificationSwap = (req: Request, res: Response): void => {
  const assets: SwapAsset[] = Array.isArray(req.body?.assets) ? req.body.assets : [];
  const intervalSeconds = Number(req.body?.intervalSeconds) > 0 ? Number(req.body.intervalSeconds) : 300;

  if (assets.length === 0) {
    res.status(400).json({ error: "assets array is required" });
    return;
  }

  const sliceCount = computeSliceCount(assets);
  const schedule = buildSchedule(assets, sliceCount, intervalSeconds);
  const maxImpactPct = schedule.reduce((max, s) => Math.max(max, s.estimatedImpactPct), 0);
  const totalNotionalUsd = assets.reduce((sum, a) => sum + a.amount * a.priceUsd, 0);

  const result: SimulationResult = {
    totalNotionalUsd,
    sliceCount,
    intervalSeconds,
    maxImpactPct,
    withinImpactTarget: maxImpactPct < IMPACT_TARGET_PCT,
    schedule,
    gas: buildGasBreakdown(sliceCount, assets.length),
  };

  res.json(result);
};

router.post("/diversification/simulate", simulateDiversificationSwap);

export default router;