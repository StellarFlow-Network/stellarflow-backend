/**
 * Yield Farming Token Emission Schedule Service
 * Calculates emission rates and projections based on halving schedules
 */

export interface EmissionSchedule {
  period: number;
  startBlock: number;
  endBlock: number;
  emissionRate: number; // tokens per block
  halvingFactor: number;
}

export interface EmissionMetrics {
  currentBlock: number;
  currentEmissionRate: number;
  currentPeriod: number;
  nextHalvingBlock: number;
  blocksUntilHalving: number;
  estimatedTimeUntilHalving: number; // in seconds
}

export interface EmissionProjection {
  days: number;
  totalEmission: number;
  averageDailyEmission: number;
  blocksInPeriod: number;
  startPeriod: number;
  endPeriod: number;
}

export interface EmissionResponse {
  success: boolean;
  data?: {
    metrics: EmissionMetrics;
    projections: EmissionProjection[];
    schedule: EmissionSchedule[];
  };
  error?: string;
}

export class YieldEmissionService {
  private readonly BLOCK_TIME_SECONDS = 5; // 5 seconds per block
  private readonly GENESIS_BLOCK = 0;
  private readonly INITIAL_EMISSION_RATE = 1000; // Initial tokens per block
  private readonly HALVING_INTERVAL_BLOCKS = 630720; // Approximately 1 year (365 days * 24 hours * 3600 seconds / 5 seconds)
  private readonly HALVING_FACTOR = 0.5; // 50% reduction each halving

  /**
   * Get the current block number (simulated - in production, fetch from blockchain)
   */
  private getCurrentBlock(): number {
    // In production, this would fetch from the blockchain
    // For now, simulate based on time since genesis
    const genesisTime = new Date("2024-01-01T00:00:00Z").getTime();
    const currentTime = Date.now();
    const elapsedSeconds = (currentTime - genesisTime) / 1000;
    return Math.floor(elapsedSeconds / this.BLOCK_TIME_SECONDS);
  }

  /**
   * Set a custom current block for testing purposes
   * @param block - The block number to set as current
   */
  public setCurrentBlock(block: number): void {
    // This method allows overriding the current block for testing
    // In production, this would be removed or secured
    (this as any).testCurrentBlock = block;
  }

  /**
   * Reset to use actual current block
   */
  public resetCurrentBlock(): void {
    delete (this as any).testCurrentBlock;
  }

  /**
   * Get current block (with test override support)
   */
  private getActualCurrentBlock(): number {
    if ((this as any).testCurrentBlock !== undefined) {
      return (this as any).testCurrentBlock;
    }
    return this.getCurrentBlock();
  }

  /**
   * Generate the emission schedule based on halving intervals
   */
  private generateEmissionSchedule(): EmissionSchedule[] {
    const schedule: EmissionSchedule[] = [];
    const totalPeriods = 20; // 20 halving periods
    let currentEmissionRate = this.INITIAL_EMISSION_RATE;
    let currentBlock = this.GENESIS_BLOCK;

    for (let period = 0; period < totalPeriods; period++) {
      const endBlock = currentBlock + this.HALVING_INTERVAL_BLOCKS;
      
      schedule.push({
        period: period + 1,
        startBlock: currentBlock,
        endBlock: endBlock,
        emissionRate: currentEmissionRate,
        halvingFactor: this.HALVING_FACTOR,
      });

      currentBlock = endBlock;
      currentEmissionRate *= this.HALVING_FACTOR;
    }

    return schedule;
  }

  /**
   * Calculate current emission metrics
   */
  private calculateCurrentMetrics(schedule: EmissionSchedule[]): EmissionMetrics {
    const currentBlock = this.getActualCurrentBlock();
    
    // Find current period
    const currentPeriodData = schedule.find(
      (period) => currentBlock >= period.startBlock && currentBlock < period.endBlock
    );

    if (!currentPeriodData) {
      // If beyond schedule, use last period
      const lastPeriod = schedule[schedule.length - 1];
      if (!lastPeriod) {
        throw new Error("No emission schedule available");
      }
      return {
        currentBlock,
        currentEmissionRate: lastPeriod.emissionRate,
        currentPeriod: lastPeriod.period,
        nextHalvingBlock: Infinity,
        blocksUntilHalving: Infinity,
        estimatedTimeUntilHalving: Infinity,
      };
    }

    const nextHalvingBlock = currentPeriodData.endBlock;
    const blocksUntilHalving = nextHalvingBlock - currentBlock;
    const estimatedTimeUntilHalving = blocksUntilHalving * this.BLOCK_TIME_SECONDS;

    return {
      currentBlock,
      currentEmissionRate: currentPeriodData.emissionRate,
      currentPeriod: currentPeriodData.period,
      nextHalvingBlock,
      blocksUntilHalving,
      estimatedTimeUntilHalving,
    };
  }

  /**
   * Calculate emission projections for given time periods
   */
  private calculateProjections(
    schedule: EmissionSchedule[],
    metrics: EmissionMetrics
  ): EmissionProjection[] {
    const dayPeriods = [30, 90, 365];
    const projections: EmissionProjection[] = [];

    for (const days of dayPeriods) {
      const blocksInPeriod = Math.floor((days * 24 * 3600) / this.BLOCK_TIME_SECONDS);
      const startBlock = metrics.currentBlock;
      const endBlock = startBlock + blocksInPeriod;

      let totalEmission = 0;
      let currentBlock = startBlock;
      let startPeriod = metrics.currentPeriod;
      let endPeriod = metrics.currentPeriod;

      // Calculate emissions across periods
      while (currentBlock < endBlock) {
        const periodData = schedule.find(
          (period) => currentBlock >= period.startBlock && currentBlock < period.endBlock
        );

        if (!periodData) {
          break;
        }

        const blocksInThisPeriod = Math.min(
          periodData.endBlock - currentBlock,
          endBlock - currentBlock
        );

        totalEmission += blocksInThisPeriod * periodData.emissionRate;
        currentBlock += blocksInThisPeriod;
        endPeriod = periodData.period;
      }

      const averageDailyEmission = totalEmission / days;

      projections.push({
        days,
        totalEmission,
        averageDailyEmission,
        blocksInPeriod,
        startPeriod,
        endPeriod,
      });
    }

    return projections;
  }

  /**
   * Get complete emission data including metrics, projections, and schedule
   */
  async getEmissions(): Promise<EmissionResponse> {
    try {
      const schedule = this.generateEmissionSchedule();
      const metrics = this.calculateCurrentMetrics(schedule);
      const projections = this.calculateProjections(schedule, metrics);

      return {
        success: true,
        data: {
          metrics,
          projections,
          schedule,
        },
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : "Failed to calculate emissions",
      };
    }
  }

  /**
   * Get current block emission rate only
   */
  async getCurrentEmissionRate(): Promise<{ success: boolean; data?: number; error?: string }> {
    try {
      const schedule = this.generateEmissionSchedule();
      const metrics = this.calculateCurrentMetrics(schedule);

      return {
        success: true,
        data: metrics.currentEmissionRate,
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : "Failed to calculate emission rate",
      };
    }
  }

  /**
   * Get emission schedule only
   */
  async getEmissionSchedule(): Promise<{ success: boolean; data?: EmissionSchedule[]; error?: string }> {
    try {
      const schedule = this.generateEmissionSchedule();

      return {
        success: true,
        data: schedule,
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : "Failed to generate schedule",
      };
    }
  }
}
