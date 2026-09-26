// src/monitoring/anchor-latency-sla.service.ts
import { Injectable, Logger } from '@nestjs/common';
import { DataSource } from 'typeorm';

interface AnchorSLAConfig {
    anchorId: string;
    maxAllowedDurationSeconds: number;
}

@Injectable()
export class AnchorLatencySLAMonitorService {
    private readonly logger = new Logger(AnchorLatencySLAMonitorService.name);
    
    // Configured SLA limits per anchor corridor (e.g., 300 seconds = 5 minutes max)
    private readonly slaConfigs: Map<string, number> = new Map([
        ['ANCHOR_EU_SEPA', 300],
        ['ANCHOR_US_ACH', 600],
        ['ANCHOR_LATAM_PIX', 180],
    ]);

    constructor(private readonly dataSource: DataSource) {}

    async evaluateAnchorCorridors(): Promise<{ evaluatedCorridors: number; violationsDetected: number }> {
        this.logger.log('Executing Anchor Payout Corridor Latency SLA Evaluation...');

        const queryRunner = this.dataSource.createQueryRunner();
        await queryRunner.connect();

        try {
            // Calculate rolling average settlement duration (in seconds) from ESCROWED to SETTLED per anchor over the last hour
            const results = await queryRunner.query(`
                SELECT 
                    anchor_id AS "anchorId",
                    AVG(EXTRACT(EPOCH FROM (settled_at - escrowed_at))) AS "avgDurationSeconds",
                    COUNT(*) as "totalTransactions"
                FROM v2_payout_transactions
                WHERE status = 'SETTLED' 
                  AND settled_at >= NOW() - INTERVAL '1 hour'
                GROUP BY anchor_id
            `);

            let violationsDetected = 0;

            for (const row of results) {
                const anchorId = row.anchorId;
                const avgDuration = parseFloat(row.avgDurationSeconds);
                const slaLimit = this.slaConfigs.get(anchorId) || 300; // Default 5 min SLA

                this.logger.log(`Anchor [${anchorId}] avg settlement duration: ${Math.round(avgDuration)}s (SLA limit: ${slaLimit}s)`);

                if (avgDuration > slaLimit) {
                    violationsDetected++;
                    this.logger.warn(`🚨 SLA VIOLATION ALERT: Anchor ${anchorId} average settlement time (${Math.round(avgDuration)}s) exceeded SLA limit (${slaLimit}s)!`);
                    
                    // Emit alert metric or trigger webhook alert notification here
                    await this.recordSLAViolationMetric(anchorId, avgDuration, slaLimit);
                }
            }

            return { evaluatedCorridors: results.length, violationsDetected };
        } catch (error) {
            this.logger.error(`Failed to evaluate anchor latency SLA: ${error.message}`);
            throw error;
        } finally {
            await queryRunner.release();
        }
    }

    private async recordSLAViolationMetric(anchorId: string, duration: number, limit: number): Promise<void> {
        // Persist SLA incident alert to monitoring logs
        this.logger.warn(`Recorded SLA incident for ${anchorId}: duration=${duration}, threshold=${limit}`);
    }
}