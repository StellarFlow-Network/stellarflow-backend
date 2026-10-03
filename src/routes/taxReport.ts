import { Router, Request, Response } from "express";
import { sendApiError } from "../lib/apiError.js";
import { taxReportService } from "../services/taxReportService";
import type { TaxExportFormat } from "../services/taxReportService";
import { taxReportExportWorker } from "../jobs/taxReportExportWorker";

const router = Router();

const FORMATS: TaxExportFormat[] = ["cointracker", "koinly"];

function parseFormat(raw: unknown): TaxExportFormat | null {
  if (raw === undefined) return "cointracker";
  if (typeof raw !== "string") return null;
  const normalized = raw.trim().toLowerCase();
  return (FORMATS as string[]).includes(normalized)
    ? (normalized as TaxExportFormat)
    : null;
}

function parseDate(raw: unknown): Date | null | undefined {
  if (raw === undefined) return undefined;
  if (typeof raw !== "string") return null;
  const date = new Date(raw);
  return Number.isNaN(date.getTime()) ? null : date;
}

/**
 * GET /api/v1/users/:address/tax-report
 *
 * Streams a tax-compliant CSV export of the user's swap, deposit and yield
 * history. Supports ISO date filters (`from`, `to`) and `format=cointracker`
 * (default) or `format=koinly`. Pass `async=true` for large histories to enqueue
 * a background export job instead of streaming inline.
 *
 * @swagger
 * /api/v1/users/{address}/tax-report:
 *   get:
 *     tags: [Exports]
 *     summary: Export user transaction history in a tax-compliant format
 *     parameters:
 *       - in: path
 *         name: address
 *         required: true
 *         schema:
 *           type: string
 *       - in: query
 *         name: from
 *         schema:
 *           type: string
 *           format: date-time
 *       - in: query
 *         name: to
 *         schema:
 *           type: string
 *           format: date-time
 *       - in: query
 *         name: format
 *         schema:
 *           type: string
 *           enum: [cointracker, koinly]
 *       - in: query
 *         name: async
 *         schema:
 *           type: boolean
 *     responses:
 *       200:
 *         description: CSV export.
 *       202:
 *         description: Background export job accepted.
 */
router.get("/:address/tax-report", async (req: Request, res: Response) => {
  const address =
    typeof req.params.address === "string" ? req.params.address.trim() : "";
  if (!address) {
    sendApiError(res, 400, "VALIDATION_ERROR", "address is required");
    return;
  }

  const format = parseFormat(req.query.format);
  if (!format) {
    sendApiError(
      res,
      400,
      "VALIDATION_ERROR",
      "format must be one of: cointracker, koinly",
    );
    return;
  }

  const from = parseDate(req.query.from);
  const to = parseDate(req.query.to);
  if (from === null) {
    sendApiError(res, 400, "VALIDATION_ERROR", "from must be an ISO date");
    return;
  }
  if (to === null) {
    sendApiError(res, 400, "VALIDATION_ERROR", "to must be an ISO date");
    return;
  }

  const request = {
    address,
    format,
    ...(from ? { from } : {}),
    ...(to ? { to } : {}),
  };

  if (req.query.async === "true") {
    try {
      const job = await taxReportExportWorker.enqueue({
        address,
        format,
        ...(from ? { from: from.toISOString() } : {}),
        ...(to ? { to: to.toISOString() } : {}),
      });
      res.status(202).json({ success: true, data: job });
    } catch (error) {
      sendApiError(
        res,
        503,
        "SERVICE_UNAVAILABLE",
        error instanceof Error ? error.message : "Export queue unavailable",
      );
    }
    return;
  }

  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader(
    "Content-Disposition",
    `attachment; filename="tax-report-${address}-${format}.csv"`,
  );

  try {
    for await (const chunk of taxReportService.streamReport(request)) {
      res.write(chunk);
    }
    res.end();
  } catch (error) {
    if (res.headersSent) {
      res.end();
      return;
    }
    sendApiError(
      res,
      500,
      "INTERNAL_SERVER_ERROR",
      error instanceof Error ? error.message : "Failed to generate tax report",
    );
  }
});

export default router;
