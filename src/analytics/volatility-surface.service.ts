// src/analytics/volatility-surface.service.ts
import { Injectable, Logger, Inject } from '@nestjs/common';
import { CACHE_MANAGER } from '@nestjs/cache-manager';
import { Cache } from 'cache-manager';
import { DataSource } from 'typeorm';

export interface VolatilitySurfaceMatrix {
    poolId: string;
    volatility7d: number;
    volatility30d: number;
    volatility90d: number;
    updatedAt: string;
}

@Injectable()
export class VolatilitySurfaceService {
    private readonly logger = new Logger(VolatilitySurfaceService.name);
    private readonly CACHE_KEY = 'analytics:volatility_surface';
    private readonly CACHE_TTL = 21600; // 6 hours in seconds

    constructor(
        private readonly dataSource: DataSource,
        @Inject(CACHE_MANAGER) private readonly cacheManager: Cache,
    ) {}

    async getVolatilitySurface(): Promise<VolatilitySurfaceMatrix[]> {
        // 1. Check Redis cache first
        const cached = await this.cacheManager.get<VolatilitySurfaceMatrix[]>(this.CACHE_KEY);
        if (cached) {
            this.logger.log('Serving volatility surface matrix from Redis cache');
            return cached;
        }

        // 2. Compute surfaces if cache miss
        const surfaces = await this.calculateVolatilitySurfaces();

        // 3. Cache computed data for 6 hours (21,600 seconds)
        await this.cacheManager.set(this.CACHE_KEY, surfaces, this.CACHE_TTL);
        return surfaces;
    }

    private async calculateVolatilitySurfaces(): Promise<VolatilitySurfaceMatrix[]> {
        this.logger.log('Computing 7d, 30d, and 90d annualized liquidity pool volatility matrices...');
        const queryRunner = this.dataSource.createQueryRunner();
        await queryRunner.connect();

        try {
            // Calculate annualized standard deviation of log returns over 7d, 30d, and 90d historical windows
            const results = await queryRunner.query(`
                SELECT 
                    pool_id AS "poolId",
                    COALESCE(STDDEV(price_return_7d) * SQRT(365), 0.0) AS "volatility7d",
                    COALESCE(STDDEV(price_return_30d) * SQRT(365), 0.0) AS "volatility30d",
                    COALESCE(STDDEV(price_return_90d) * SQRT(365), 0.0) AS "volatility90d"
                FROM v2_pool_price_returns
                GROUP BY pool_id
            `);

            return results.map(row => ({
                poolId: row.poolId,
                volatility7d: parseFloat(row.volatility7d),
                volatility30d: parseFloat(row.volatility30d),
                volatility90d: parseFloat(row.volatility90d),
                updatedAt: new Date().toISOString(),
            }));
        } finally {
            await queryRunner.release();
        }
    }
}