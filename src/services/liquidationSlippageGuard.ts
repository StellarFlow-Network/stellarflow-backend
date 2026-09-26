export const MAX_LIQUIDATION_SLIPPAGE_PERCENT = 3;

export interface LiquidationSale {
  positionId: string;
  collateralAsset: string;
  debtAsset: string;
  collateralAmount: number;
}

export interface LiquidationMarketQuote {
  expectedOutput: number;
  quotedOutput: number;
  quoteId?: string;
}

export interface LiquidationAuctionBatch extends LiquidationSale {
  batchNumber: number;
  batchCount: number;
  expectedOutput: number;
  minimumOutput: number;
  quoteId?: string;
}

export interface LiquidationAuctionHouse {
  createBatchAuction(batch: LiquidationAuctionBatch): Promise<void>;
}

export interface ProtectedLiquidationSwapExecutor {
  execute(batch: LiquidationAuctionBatch): Promise<{
    transactionId: string;
    outputAmount: number;
  }>;
}

export interface LiquidationSlippageGuardOptions {
  maxSlippagePercent?: number;
  maxBatchAmount?: number;
}

export interface LiquidationBatchResult {
  batchNumber: number;
  batchCount: number;
  transactionId: string;
  inputAmount: number;
  outputAmount: number;
  minimumOutput: number;
}

export class LiquidationSlippageExceededError extends Error {
  readonly code = "LIQUIDATION_SLIPPAGE_EXCEEDED";
  readonly slippagePercent: number;
  readonly thresholdPercent: number;

  constructor(slippagePercent: number, thresholdPercent: number) {
    super(
      `Liquidation market slippage ${slippagePercent.toFixed(4)}% exceeds the ${thresholdPercent}% limit`,
    );
    this.name = "LiquidationSlippageExceededError";
    this.slippagePercent = slippagePercent;
    this.thresholdPercent = thresholdPercent;
  }
}

function assertPositiveFinite(value: number, fieldName: string): void {
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${fieldName} must be a positive finite number`);
  }
}

/** Protects liquidation swaps before auction creation and execution. */
export class LiquidationSlippageGuard {
  private readonly maxSlippagePercent: number;
  private readonly maxBatchAmount: number;

  constructor(
    private readonly auctionHouse: LiquidationAuctionHouse,
    private readonly executor: ProtectedLiquidationSwapExecutor,
    private readonly quoteMarket: (
      collateralAsset: string,
      debtAsset: string,
      collateralAmount: number,
    ) => Promise<LiquidationMarketQuote>,
    options: LiquidationSlippageGuardOptions = {},
  ) {
    this.maxSlippagePercent =
      options.maxSlippagePercent ?? MAX_LIQUIDATION_SLIPPAGE_PERCENT;
    this.maxBatchAmount = options.maxBatchAmount ?? 1_000;
    assertPositiveFinite(this.maxSlippagePercent, "maxSlippagePercent");
    if (this.maxSlippagePercent > MAX_LIQUIDATION_SLIPPAGE_PERCENT) {
      throw new Error(
        `maxSlippagePercent cannot exceed ${MAX_LIQUIDATION_SLIPPAGE_PERCENT}%`,
      );
    }
    assertPositiveFinite(this.maxBatchAmount, "maxBatchAmount");
  }

  getMaximumAllowableSlippage(expectedOutput: number): {
    slippagePercent: number;
    minimumOutput: number;
  } {
    assertPositiveFinite(expectedOutput, "expectedOutput");
    const slippageFraction = this.maxSlippagePercent / 100;
    return {
      slippagePercent: this.maxSlippagePercent,
      minimumOutput: expectedOutput * (1 - slippageFraction),
    };
  }

  calculateMarketSlippagePercent(
    expectedOutput: number,
    quotedOutput: number,
  ): number {
    assertPositiveFinite(expectedOutput, "expectedOutput");
    if (!Number.isFinite(quotedOutput) || quotedOutput < 0) {
      throw new Error("quotedOutput must be a finite non-negative number");
    }
    return Math.max(0, ((expectedOutput - quotedOutput) / expectedOutput) * 100);
  }

  async executeCollateralLiquidation(
    sale: LiquidationSale,
  ): Promise<LiquidationBatchResult[]> {
    this.validateSale(sale);
    const batches = this.splitIntoBatches(sale);
    const results: LiquidationBatchResult[] = [];

    for (const batch of batches) {
      const quote = await this.quoteMarket(
        batch.collateralAsset,
        batch.debtAsset,
        batch.collateralAmount,
      );
      const slippagePercent = this.calculateMarketSlippagePercent(
        quote.expectedOutput,
        quote.quotedOutput,
      );
      if (slippagePercent > this.maxSlippagePercent) {
        throw new LiquidationSlippageExceededError(
          slippagePercent,
          this.maxSlippagePercent,
        );
      }

      const { minimumOutput } = this.getMaximumAllowableSlippage(
        quote.expectedOutput,
      );
      const protectedBatch: LiquidationAuctionBatch = {
        ...batch,
        expectedOutput: quote.expectedOutput,
        minimumOutput,
        ...(quote.quoteId ? { quoteId: quote.quoteId } : {}),
      };

      await this.auctionHouse.createBatchAuction(protectedBatch);
      const executed = await this.executor.execute(protectedBatch);
      if (executed.outputAmount < minimumOutput) {
        throw new Error(
          `Liquidation execution ${executed.transactionId} returned less than the protected minimum output`,
        );
      }
      results.push({
        batchNumber: protectedBatch.batchNumber,
        batchCount: protectedBatch.batchCount,
        transactionId: executed.transactionId,
        inputAmount: protectedBatch.collateralAmount,
        outputAmount: executed.outputAmount,
        minimumOutput,
      });
    }

    return results;
  }

  private splitIntoBatches(sale: LiquidationSale): LiquidationAuctionBatch[] {
    const batchCount = Math.ceil(sale.collateralAmount / this.maxBatchAmount);
    return Array.from({ length: batchCount }, (_, index) => ({
      ...sale,
      batchNumber: index + 1,
      batchCount,
      collateralAmount: Math.min(
        this.maxBatchAmount,
        sale.collateralAmount - index * this.maxBatchAmount,
      ),
      expectedOutput: 0,
      minimumOutput: 0,
    }));
  }

  private validateSale(sale: LiquidationSale): void {
    if (!sale.positionId || !sale.collateralAsset || !sale.debtAsset) {
      throw new Error("Liquidation sale identifiers and assets are required");
    }
    if (sale.collateralAsset === sale.debtAsset) {
      throw new Error("Liquidation collateral and debt assets must differ");
    }
    assertPositiveFinite(sale.collateralAmount, "collateralAmount");
  }
}