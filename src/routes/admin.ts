import { Router } from "express";
import { sendApiError } from "../lib/apiError.js";
import fs from "fs";
import path from "path";
import Joi from "joi";
import {
  buildMonthlySummary,
  renderHTML,
  renderPDF,
} from "../services/reportService";
import { updateSecretKey } from "../services/secretManager";
import { getAppConfig, CONFIG_PATH } from "../config/configWatcher";
import { refreshWhitelistCache } from "../middleware/rateLimitMiddleware";
import {
  getRelayerRegistry,
  getRelayerRegistryById,
} from "../controllers/adminController";
import {
  getDLQEntries,
  getDLQStats,
  replayDLQEntry,
  replayAllDLQEntries,
  getKmsRotationStatus,
} from "../controllers/dlqController";
import {
  listDisputes,
  getDisputeById,
  transitionDisputeStatus,
  triggerManualRefund,
} from "../controllers/disputeController";

const rateLimitUpdateSchema = Joi.object({
  windowMs: Joi.number().integer().min(1000).max(86400000).optional(),
  maxRequests: Joi.number().integer().min(1).max(100000).optional(),
  enabled: Joi.boolean().optional(),
});

const router = Router();

/**
 * @swagger
 * /api/admin/reports/summary:
 *   get:
 *     tags:
 *       - Admin
 *     summary: Generate Oracle Usage Summary Report
 *     description: >
 *       Generates a professional monthly summary report covering oracle uptime,
 *       total price updates pushed to Stellar, and average price stability.
 *       Supports HTML (default) and PDF output formats.
 *     parameters:
 *       - in: query
 *         name: format
 *         schema:
 *           type: string
 *           enum: [html, pdf]
 *           default: html
 *         description: Output format — "html" returns an HTML page, "pdf" returns a downloadable PDF file.
 *       - in: query
 *         name: month
 *         schema:
 *           type: string
 *           example: "2025-03"
 *         description: >
 *           Target month in YYYY-MM format. Defaults to the current calendar month.
 *     responses:
 *       '200':
 *         description: Report generated successfully
 *         content:
 *           text/html:
 *             schema:
 *               type: string
 *           application/pdf:
 *             schema:
 *               type: string
 *               format: binary
 *       '400':
 *         description: Invalid month format
 *       '500':
 *         description: Internal server error
 */
router.get("/reports/summary", async (req, res) => {
  const format =
    (req.query.format as string | undefined)?.toLowerCase() ?? "html";
  const month = req.query.month as string | undefined;

  if (month && !/^\d{4}-\d{2}$/.test(month)) {
    sendApiError(
      res,
      400,
      "BAD_REQUEST",
      "Invalid month format. Use YYYY-MM (e.g. 2025-03).",
    );
    return;
  }

  if (format !== "html" && format !== "pdf") {
    res.status(400).json({
      success: false,
      error: "Invalid format. Supported values: html, pdf.",
    });
    return;
  }

  try {
    const summary = await buildMonthlySummary(month);

    if (format === "pdf") {
      const pdfBuffer = await renderPDF(summary);
      res.setHeader("Content-Type", "application/pdf");
      res.setHeader(
        "Content-Disposition",
        `attachment; filename="stellarflow-report-${summary.month}.pdf"`,
      );
      res.send(pdfBuffer);
      return;
    }

    // Default: HTML
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.send(renderHTML(summary));
  } catch (error) {
    console.error("[AdminReports] Failed to generate report:", error);
    sendApiError(
      res,
      500,
      "INTERNAL_SERVER_ERROR",
      typeof (error instanceof Error
        ? error.message
        : "Failed to generate report") === "string"
        ? String(
            error instanceof Error
              ? error.message
              : "Failed to generate report",
          )
        : undefined,
    );
  }
});

/**
 * @swagger
 * /api/admin/reload-secret:
 *   post:
 *     tags:
 *       - Admin
 *     summary: Reload the active Stellar secret key
 *     description: >
 *       Replaces the in-memory Stellar secret key without restarting the server.
 *       If `secretKey` is provided in the request body it is used directly;
 *       otherwise the key is re-read from `ORACLE_SECRET_KEY` / `SOROBAN_ADMIN_SECRET`.
 *     requestBody:
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               secretKey:
 *                 type: string
 *                 description: Optional Stellar secret key (strkey format starting with S)
 *     responses:
 *       '200':
 *         description: Key reloaded successfully
 *       '400':
 *         description: Validation error (empty or invalid key format)
 *       '500':
 *         description: Unexpected error during reload
 */
router.post("/reload-secret", async (req, res) => {
  try {
    if (req.body && req.body.secretKey !== undefined) {
      // Caller supplied a key — use it directly
      updateSecretKey(req.body.secretKey, "admin-endpoint");
    } else {
      // Re-read from environment
      const envKey =
        process.env.ORACLE_SECRET_KEY || process.env.SOROBAN_ADMIN_SECRET;
      if (!envKey) {
        return sendApiError(
          res,
          500,
          "INTERNAL_SERVER_ERROR",
          "Failed to reload secret key",
        );
      }
      updateSecretKey(envKey, "admin-endpoint");
    }

    return res.status(200).json({
      success: true,
      message: "Secret key reloaded successfully",
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "";
    const isValidationError =
      message === "Secret key must not be empty" ||
      message === "Invalid Stellar secret key format";

    if (isValidationError) {
      return sendApiError(
        res,
        400,
        "BAD_REQUEST",
        typeof message === "string" ? String(message) : undefined,
      );
    }

    return sendApiError(
      res,
      500,
      "INTERNAL_SERVER_ERROR",
      "Failed to reload secret key",
    );
  }
});

/**
 * @swagger
 * /api/admin/relayer-registry:
 *   get:
 *     tags:
 *       - Admin
 *     summary: Get all relayer registry entries
 *     description: Retrieve all KYC information for authorized data providers (Admin only)
 *     responses:
 *       '200':
 *         description: Registry entries retrieved successfully
 *       '500':
 *         description: Internal server error
 */
router.get("/relayer-registry", getRelayerRegistry);

/**
 * @swagger
 * /api/admin/relayer-registry/{relayerId}:
 *   get:
 *     tags:
 *       - Admin
 *     summary: Get relayer registry entry by relayer ID
 *     description: Retrieve KYC information for a specific relayer (Admin only)
 *     parameters:
 *       - in: path
 *         name: relayerId
 *         required: true
 *         schema:
 *           type: integer
 *         description: The relayer ID
 *     responses:
 *       '200':
 *         description: Registry entry retrieved successfully
 *       '400':
 *         description: Invalid relayer ID
 *       '404':
 *         description: Registry entry not found
 *       '500':
 *         description: Internal server error
 */
router.get("/relayer-registry/:relayerId", getRelayerRegistryById);

/**
 * @swagger
 * /api/admin/relayer-registry:
 *   post:
 *     tags:
 *       - Admin
 *     summary: Create or update relayer registry entry
 *     description: Create or update KYC information for a relayer (Admin only)
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               windowMs:
 *                 type: integer
 *                 description: Rolling window in milliseconds (1000–86400000)
 *                 example: 900000
 *               maxRequests:
 *                 type: integer
 *                 description: Max requests per IP per window (1–100000)
 *                 example: 100
 *               enabled:
 *                 type: boolean
 *                 description: Toggle global throttling on/off
 *                 example: true
 *     responses:
 *       '200':
 *         description: Config updated successfully
 *       '400':
 *         description: Validation error
 *       '500':
 *         description: Failed to persist config
 */
router.put("/rate-limit", async (req, res) => {
  const { error, value } = rateLimitUpdateSchema.validate(req.body, {
    abortEarly: false,
    stripUnknown: true,
  });

  if (error) {
    return res.status(400).json({
      success: false,
      error: "Validation failed",
      details: error.details.map((d) => d.message),
    });
  }

  // Persist to config.json — watchConfig will reload and replace the frozen snapshot atomically
  try {
    let fileConfig: Record<string, unknown> = {};
    try {
      fileConfig = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf-8")) as Record<
        string,
        unknown
      >;
    } catch {
      // file may not exist yet — start fresh
    }

    const existing = (fileConfig.rateLimit as Record<string, unknown>) ?? {};
    fileConfig.rateLimit = { ...existing, ...value };
    fs.writeFileSync(
      CONFIG_PATH,
      JSON.stringify(fileConfig, null, 2) + "\n",
      "utf-8",
    );
  } catch (err) {
    console.error("[AdminRateLimit] Failed to persist config.json:", err);
    return sendApiError(
      res,
      500,
      "INTERNAL_SERVER_ERROR",
      "Rate-limit updated in memory but failed to persist to disk",
    );
  }

  console.info(
    "[AdminRateLimit] Rate-limit config updated:",
    getAppConfig().rateLimit,
  );

  return res.json({
    success: true,
    message: "Rate-limit configuration updated",
    rateLimit: getAppConfig().rateLimit,
  });
});

/**
 * @swagger
 * /api/admin/rate-limit/whitelist/refresh:
 *   post:
 *     tags:
 *       - Admin
 *     summary: Force-refresh the IP whitelist cache
 *     description: >
 *       Immediately reloads whitelisted IPs from the Relayer table.
 *       Useful after adding or removing IPs from a relayer record.
 *     responses:
 *       '200':
 *         description: Whitelist refreshed
 */
router.post("/rate-limit/whitelist/refresh", async (_req, res) => {
  try {
    await refreshWhitelistCache();
    return res.json({
      success: true,
      message: "IP whitelist cache refreshed",
    });
  } catch (err) {
    console.error("[AdminRateLimit] Whitelist refresh failed:", err);
    return sendApiError(
      res,
      500,
      "INTERNAL_SERVER_ERROR",
      "Failed to refresh whitelist cache",
    );
  }
});

// ---------------------------------------------------------------------------
// DLQ Inspection & Replay Endpoints (Issue #717)
// ---------------------------------------------------------------------------

/**
 * @swagger
 * /api/v1/admin/dlq:
 *   get:
 *     tags:
 *       - Admin
 *     summary: Inspect Dead-Letter Queue entries
 *     description: >
 *       Returns failed ingestion payload entries from the Redis Dead-Letter
 *       Queue.  Supports optional pagination and filtering by failure status.
 *     parameters:
 *       - in: query
 *         name: start
 *         schema:
 *           type: integer
 *           default: 0
 *         description: Redis list start index (0-based).
 *       - in: query
 *         name: end
 *         schema:
 *           type: integer
 *           default: 99
 *         description: Redis list end index (inclusive).
 *       - in: query
 *         name: include_failed
 *         schema:
 *           type: boolean
 *           default: true
 *         description: Include permanently-failed entries when true.
 *     responses:
 *       '200':
 *         description: DLQ entries and stats returned successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 stats:
 *                   type: object
 *                 entries:
 *                   type: array
 *                 page:
 *                   type: object
 *       '500':
 *         description: Internal server error
 */
router.get("/dlq", getDLQEntries);

/**
 * @swagger
 * /api/v1/admin/dlq/stats:
 *   get:
 *     tags:
 *       - Admin
 *     summary: Get Dead-Letter Queue statistics
 *     description: Returns aggregate counts and timestamp metadata for the DLQ.
 *     responses:
 *       '200':
 *         description: DLQ stats retrieved successfully
 *       '500':
 *         description: Internal server error
 */
router.get("/dlq/stats", getDLQStats);

/**
 * @swagger
 * /api/v1/admin/dlq/replay:
 *   post:
 *     tags:
 *       - Admin
 *     summary: Replay Dead-Letter Queue payloads
 *     description: >
 *       Manually re-enqueues one or all pending DLQ payloads back into
 *       the ingestion pipeline.  Applies exponential backoff retry policy.
 *     requestBody:
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               entry_id:
 *                 type: integer
 *                 description: >
 *                   Replay a single entry by ID.  Omit to replay all
 *                   pending entries.
 *               purge_on_success:
 *                 type: boolean
 *                 description: Purge the DLQ after successful full replay.
 *     responses:
 *       '200':
 *         description: Replay results returned
 *       '404':
 *         description: Entry not found (when entry_id is provided)
 *       '500':
 *         description: Internal server error
 */
router.post("/dlq/replay", replayDLQEntry);

/**
 * @swagger
 * /api/v1/admin/dlq/replay/all:
 *   post:
 *     tags:
 *       - Admin
 *     summary: Replay all pending Dead-Letter Queue payloads
 *     description: Shorthand to replay every pending DLQ entry without specifying entry_id.
 *     requestBody:
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               purge_on_success:
 *                 type: boolean
 *                 default: false
 *     responses:
 *       '200':
 *         description: Bulk replay results returned
 *       '500':
 *         description: Internal server error
 */
router.post("/dlq/replay/all", replayAllDLQEntries);

// ---------------------------------------------------------------------------
// KMS Key Rotation Status Endpoint (Issue #718)
// ---------------------------------------------------------------------------

/**
 * @swagger
 * /api/v1/admin/kms/rotation-status:
 *   get:
 *     tags:
 *       - Admin
 *     summary: Get KMS key rotation status
 *     description: >
 *       Returns the currently active key handle metadata and the last
 *       N rotation events for observability and audit purposes.
 *     responses:
 *       '200':
 *         description: KMS rotation status returned successfully
 *       '500':
 *         description: Internal server error
 */
router.get("/kms/rotation-status", getKmsRotationStatus);

// ---------------------------------------------------------------------------
// Remittance Dispute Resolution (Issue #834)
// ---------------------------------------------------------------------------

/**
 * @swagger
 * /api/admin/remittance/disputes:
 *   get:
 *     tags:
 *       - Admin
 *     summary: List remittance dispute tickets
 *     description: >
 *       Returns dispute tickets tracked for fiat payouts that failed or timed
 *       out.  Optional filters: status (open|investigating|refunded|closed),
 *       userId, limit, offset.
 *     parameters:
 *       - in: query
 *         name: status
 *         schema:
 *           type: string
 *           enum: [open, investigating, refunded, closed]
 *         description: Filter by dispute ticket status
 *       - in: query
 *         name: userId
 *         schema:
 *           type: string
 *         description: Filter by the affected user ID
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *           default: 50
 *         description: Max records to return (1-200)
 *       - in: query
 *         name: offset
 *         schema:
 *           type: integer
 *           default: 0
 *         description: Offset for pagination
 *     responses:
 *       '200':
 *         description: Dispute tickets returned
 *       '400':
 *         description: Invalid status filter
 *       '500':
 *         description: Internal server error
 */
router.get("/remittance/disputes", listDisputes);

/**
 * @swagger
 * /api/admin/remittance/disputes/{id}:
 *   get:
 *     tags:
 *       - Admin
 *     summary: Get a remittance dispute ticket
 *     description: Returns a single dispute ticket by ID.
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *         description: Dispute ticket ID
 *     responses:
 *       '200':
 *         description: Dispute ticket returned
 *       '404':
 *         description: Dispute ticket not found
 *       '500':
 *         description: Internal server error
 */
router.get("/remittance/disputes/:id", getDisputeById);

/**
 * @swagger
 * /api/admin/remittance/disputes/{id}/status:
 *   post:
 *     tags:
 *       - Admin
 *     summary: Transition a dispute ticket status
 *     description: >
 *       Advances a dispute ticket through its state machine
 *       (open -> investigating -> refunded | closed).  A state change
 *       dispatches email + webhook updates to the affected user.
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *         description: Dispute ticket ID
 *     requestBody:
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               status:
 *                 type: string
 *                 enum: [open, investigating, refunded, closed]
 *               email:
 *                 type: string
 *                 description: Override notification email address
 *               webhookUrl:
 *                 type: string
 *                 description: Override notification webhook endpoint
 *     responses:
 *       '200':
 *         description: Dispute ticket transitioned
 *       '400':
 *         description: Invalid target status
 *       '404':
 *         description: Dispute ticket not found
 *       '409':
 *         description: Invalid state transition
 *       '500':
 *         description: Internal server error
 */
router.post("/remittance/disputes/:id/status", transitionDisputeStatus);

/**
 * @swagger
 * /api/admin/remittance/disputes/{id}/refund:
 *   post:
 *     tags:
 *       - Admin
 *     summary: Trigger a manual refund for a dispute ticket
 *     description: >
 *       Allows an operator to manually refund a dispute ticket.  Moves the
 *       ticket to `refunded`, records the refund metadata and dispatches the
 *       email + webhook update to the affected user.
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *         description: Dispute ticket ID
 *     requestBody:
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               refundAmount:
 *                 type: number
 *                 description: Amount refunded (optional)
 *               email:
 *                 type: string
 *                 description: Override notification email address
 *               webhookUrl:
 *                 type: string
 *                 description: Override notification webhook endpoint
 *     responses:
 *       '200':
 *         description: Manual refund triggered
 *       '400':
 *         description: Invalid refund amount
 *       '404':
 *         description: Dispute ticket not found
 *       '409':
 *         description: Dispute already closed
 *       '500':
 *         description: Internal server error
 */
router.post("/remittance/disputes/:id/refund", triggerManualRefund);

export default router;
