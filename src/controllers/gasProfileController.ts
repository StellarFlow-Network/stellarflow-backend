/**
 * Gas Profiler Controller – Issue #786
 *
 * Handles:
 *   GET /api/v1/gas-profile          – daily average cost per transaction type
 *   GET /api/v1/gas-profile/status   – profiler worker health
 */

import { Request, Response } from "express";
import { sendApiError } from "../lib/apiError.js";
import { stroopsToXlm } from "../services/gasProfiler/gasAggregator";
import { TRACKED_TX_TYPES } from "../services/gasProfiler/gasMetrics.types";
import { getGasProfilerService } from "../services/gasProfiler/gasProfilerService";

const VALID_TX_TYPES = new Set<string>([
  ...TRACKED_TX_TYPES,
  "other",
  "unknown",
]);

/**
 * GET /api/v1/gas-profile
 *
 * Query parameters:
 *   from     {string}  Optional ISO-8601 start day (default: 6 days ago UTC)
 *   to       {string}  Optional ISO-8601 end day   (default: today UTC)
 *   txType   {string}  Optional filter: swap | deposit | withdraw | other | unknown
 *   limit    {number}  Optional max rows (default: 100, max: 500)
 */
export async function getGasProfile(
  req: Request,
  res: Response,
): Promise<void> {
  try {
    const { from, to, txType, limit: limitParam } = req.query;

    if (txType !== undefined) {
      if (typeof txType !== "string" || !VALID_TX_TYPES.has(txType)) {
        res.status(400).json({
          success: false,
          error: {
            code: "VALIDATION_ERROR",
            message: `txType must be one of: ${[...VALID_TX_TYPES].join(", ")}`,
            timestamp: new Date().toISOString(),
          },
        });
        return;
      }
    }

    let fromDate: Date | undefined;
    let toDate: Date | undefined;

    if (from !== undefined) {
      if (typeof from !== "string" || Number.isNaN(Date.parse(from))) {
        res.status(400).json({
          success: false,
          error: {
            code: "VALIDATION_ERROR",
            message: "`from` must be a valid ISO-8601 date.",
            timestamp: new Date().toISOString(),
          },
        });
        return;
      }
      fromDate = new Date(from);
    }

    if (to !== undefined) {
      if (typeof to !== "string" || Number.isNaN(Date.parse(to))) {
        res.status(400).json({
          success: false,
          error: {
            code: "VALIDATION_ERROR",
            message: "`to` must be a valid ISO-8601 date.",
            timestamp: new Date().toISOString(),
          },
        });
        return;
      }
      toDate = new Date(to);
    }

    let limit: number | undefined;
    if (limitParam !== undefined) {
      const parsed = Number.parseInt(String(limitParam), 10);
      if (!Number.isFinite(parsed) || parsed < 1) {
        res.status(400).json({
          success: false,
          error: {
            code: "VALIDATION_ERROR",
            message: "`limit` must be a positive integer.",
            timestamp: new Date().toISOString(),
          },
        });
        return;
      }
      limit = parsed;
    }

    const rows = await getGasProfilerService().getDailyAverages({
      ...(fromDate ? { from: fromDate } : {}),
      ...(toDate ? { to: toDate } : {}),
      ...(typeof txType === "string" ? { txType } : {}),
      ...(limit !== undefined ? { limit } : {}),
    });

    res.json({
      success: true,
      data: {
        count: rows.length,
        averages: rows.map((row) => ({
          day: row.day.toISOString().slice(0, 10),
          txType: row.txType,
          sampleCount: row.sampleCount,
          avgCpuInstructions: row.avgCpuInstructions,
          avgFeeChargedStroops: row.avgFeeChargedStroops,
          avgFeeChargedXlm: stroopsToXlm(row.avgFeeChargedStroops),
          avgRentFeeStroops: row.avgRentFeeStroops,
          avgRentFeeXlm: stroopsToXlm(row.avgRentFeeStroops),
          avgDiskReadBytes: row.avgDiskReadBytes,
          avgWriteBytes: row.avgWriteBytes,
          maxCpuInstructions: row.maxCpuInstructions,
          totalFeeChargedStroops: row.totalFeeChargedStroops,
          totalFeeChargedXlm: stroopsToXlm(BigInt(row.totalFeeChargedStroops)),
        })),
      },
    });
  } catch (error) {
    sendApiError(
      res,
      500,
      "INTERNAL_SERVER_ERROR",
      error instanceof Error ? error.message : undefined,
    );
  }
}

/** GET /api/v1/gas-profile/status */
export async function getGasProfileStatus(
  _req: Request,
  res: Response,
): Promise<void> {
  try {
    const status = getGasProfilerService().getStatus();
    res.json({ success: true, data: status });
  } catch (error) {
    sendApiError(
      res,
      500,
      "INTERNAL_SERVER_ERROR",
      error instanceof Error ? error.message : undefined,
    );
  }
}
