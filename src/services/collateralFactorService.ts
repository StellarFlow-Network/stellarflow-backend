import { logger } from "../utils/logger";

/**
 * Issue #1003 – Vault Collateral Dynamic Liquidation Factor Calculation API.
 *
 * Computes a dynamic collateral valuation factor `M_i` for each vault collateral
 * asset from its 7-day liquidity depth. When an asset's market liquidity falls
 * below the configured threshold the factor is automatically reduced so the
 * protocol discounts illiquid collateral during liquidation.
 */

export interface LiquiditySample {
  timestamp: Date;
  liquidity: number;
  volume24h?: number;
  tvl?: number;
}

export interface CollateralFactorConfig {
  /** Valuation factor applied when an asset has full reference liquidity. */
  baseFactor: number;
  /** Hard floor for the valuation factor, regardless of illiquidity. */
  minimumFactor: number;
  /** Liquidity depth at (or above) which the base factor applies. */
  referenceLiquidityDepth: number;
  /** Depth below which the illiquid penalty is applied. */
  liquidityThreshold: number;
  /** Multiplier applied to the factor when depth is below the threshold. */
  illiquidPenaltyMultiplier: number;
  /** Number of trailing days used to measure liquidity depth. */
  lookbackDays: number;
}

export const DEFAULT_COLLATERAL_FACTOR_CONFIG: CollateralFactorConfig = {
  baseFactor: 0.95,
  minimumFactor: 0.5,
  referenceLiquidityDepth: 1_000_000,
  liquidityThreshold: 250_000,
  illiquidPenaltyMultiplier: 0.8,
  lookbackDays: 7,
};

export interface CollateralFactorResult {
  asset: string;
  baseFactor: number;
  /** Dynamic collateral valuation factor M_i in [minimumFactor, baseFactor]. */
  valuationFactor: number;
  liquidityDepth7d: number;
  liquidityThreshold: number;
  referenceLiquidityDepth: number;
  belowThreshold: boolean;
  penaltyApplied: boolean;
  sampleCount: number;
  lastSampleAt: string | null;
  computedAt: string;
}

export interface CollateralFactorReport {
  assets: CollateralFactorResult[];
  config: CollateralFactorConfig;
  windowStart: string;
  windowEnd: string;
  generatedAt: string;
}

export type LiquiditySampleLoader = (
  asset: string,
  windowStart: Date,
  windowEnd: Date,
) => Promise<LiquiditySample[]>;

export interface CollateralFactorsOptions {
  assets?: string[];
  now?: Date;
  loadSamples?: LiquiditySampleLoader;
}

const DEFAULT_ASSETS = ["XLM", "USDC", "NGN", "GHS", "KES"];

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(Math.max(value, min), max);
}

function round(value: number, decimals = 8): number {
  return Number(value.toFixed(decimals));
}

export function normalizeAsset(asset: string): string {
  return asset.trim().toUpperCase();
}

/**
 * Mean liquidity across every sample in the trailing window. This is the
 * liquidity-depth proxy used by the dynamic factor formula.
 */
export function computeLiquidityDepth(samples: LiquiditySample[]): number {
  if (samples.length === 0) return 0;
  const total = samples.reduce((sum, sample) => {
    const value = Number(sample.liquidity);
    return Number.isFinite(value) ? sum + value : sum;
  }, 0);
  return total / samples.length;
}

/**
 * Pure factor formula: scale the base factor linearly with liquidity depth,
 * clamp to the configured floor, then apply the illiquid penalty when depth
 * drops below the threshold.
 */
export function computeCollateralFactor(
  asset: string,
  samples: LiquiditySample[],
  config: CollateralFactorConfig = DEFAULT_COLLATERAL_FACTOR_CONFIG,
  now: Date = new Date(),
): CollateralFactorResult {
  const liquidityDepth7d = computeLiquidityDepth(samples);
  const ratio =
    config.referenceLiquidityDepth > 0
      ? liquidityDepth7d / config.referenceLiquidityDepth
      : 0;

  const scaled = config.baseFactor * clamp(ratio, 0, 1);
  let valuationFactor = clamp(scaled, config.minimumFactor, config.baseFactor);

  const belowThreshold = liquidityDepth7d < config.liquidityThreshold;
  const penaltyApplied = belowThreshold;
  if (belowThreshold) {
    valuationFactor = Math.max(
      config.minimumFactor,
      valuationFactor * config.illiquidPenaltyMultiplier,
    );
  }

  const lastSample = samples.reduce<Date | null>((latest, sample) => {
    if (!latest) return sample.timestamp;
    return sample.timestamp > latest ? sample.timestamp : latest;
  }, null);

  return {
    asset: normalizeAsset(asset),
    baseFactor: config.baseFactor,
    valuationFactor: round(valuationFactor, 6),
    liquidityDepth7d: round(liquidityDepth7d, 6),
    liquidityThreshold: config.liquidityThreshold,
    referenceLiquidityDepth: config.referenceLiquidityDepth,
    belowThreshold,
    penaltyApplied,
    sampleCount: samples.length,
    lastSampleAt: lastSample ? lastSample.toISOString() : null,
    computedAt: now.toISOString(),
  };
}

export function configuredCollateralAssets(): string[] {
  const raw = process.env.VAULT_COLLATERAL_ASSETS?.trim();
  if (!raw) return [...DEFAULT_ASSETS];
  const parsed = raw
    .split(",")
    .map((entry) => normalizeAsset(entry))
    .filter(Boolean);
  return parsed.length > 0 ? parsed : [...DEFAULT_ASSETS];
}

/**
 * Default liquidity loader backed by `PoolLiquidity` (Issue #1003). It falls
 * back to `PoolVolumeAnalytics` when no raw liquidity samples exist so assets
 * with only aggregated analytics still produce a valuation factor.
 */
const defaultLiquidityLoader: LiquiditySampleLoader = async (
  asset,
  windowStart,
  windowEnd,
) => {
  const { default: prisma } = await import("../lib/prisma");
  const db = prisma as any;
  const rows = await db.poolLiquidity.findMany({
    where: {
      poolId: asset,
      timestamp: { gte: windowStart, lte: windowEnd },
    },
    orderBy: { timestamp: "asc" },
    select: { timestamp: true, liquidity: true },
  });

  if (rows.length > 0) {
    return rows.map((row: any) => ({
      timestamp: row.timestamp,
      liquidity: Number(row.liquidity),
    }));
  }

  const analytics = await db.poolVolumeAnalytics.findMany({
    where: {
      poolId: asset,
      timestamp: { gte: windowStart, lte: windowEnd },
    },
    orderBy: { timestamp: "asc" },
    select: { timestamp: true, tvl: true, volume24h: true },
  });

  return analytics.map((row: any) => ({
    timestamp: row.timestamp,
    liquidity: Number(row.tvl),
    volume24h: Number(row.volume24h),
  }));
};

export class CollateralFactorService {
  constructor(
    private readonly config: CollateralFactorConfig = DEFAULT_COLLATERAL_FACTOR_CONFIG,
  ) {}

  async getCollateralFactors(
    options: CollateralFactorsOptions = {},
  ): Promise<CollateralFactorReport> {
    const now = options.now ?? new Date();
    const assets =
      options.assets && options.assets.length > 0
        ? options.assets.map(normalizeAsset).filter(Boolean)
        : configuredCollateralAssets();
    const loadSamples = options.loadSamples ?? defaultLiquidityLoader;

    const windowStart = new Date(
      now.getTime() - this.config.lookbackDays * 24 * 60 * 60 * 1000,
    );

    const results: CollateralFactorResult[] = [];
    for (const asset of assets) {
      let samples: LiquiditySample[] = [];
      try {
        samples = await loadSamples(asset, windowStart, now);
      } catch (error) {
        logger.warn(
          `[CollateralFactorService] Failed to load liquidity for ${asset}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
      results.push(computeCollateralFactor(asset, samples, this.config, now));
    }

    return {
      assets: results,
      config: { ...this.config },
      windowStart: windowStart.toISOString(),
      windowEnd: now.toISOString(),
      generatedAt: now.toISOString(),
    };
  }
}

export const collateralFactorService = new CollateralFactorService();
