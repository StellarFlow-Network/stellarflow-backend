import { Router } from "express";
import fs from "fs";
import path from "path";
import Joi from "joi";
import {
  buildMonthlySummary,
  renderHTML,
  renderPDF,
} from "../services/reportService";
import { updateSecretKey } from "../services/secretManager";
import { appConfig } from "../config/configWatcher";
import { refreshWhitelistCache } from "../middleware/rateLimitMiddleware";

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
    res.status(400).json({
      success: false,
      error: "Invalid month format. Use YYYY-MM (e.g. 2025-03).",
    });
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
    res.status(500).json({
      success: false,
      error:
        error instanceof Error ? error.message : "Failed to generate report",
    });
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
        return res.status(500).json({
          success: false,
          error: "Failed to reload secret key",
        });
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
      return res.status(400).json({
        success: false,
        error: message,
      });
    }

    return res.status(500).json({
      success: false,
      error: "Failed to reload secret key",
    });
  }
});

const CONFIG_PATH = path.resolve(process.cwd(), "config.json");

/** Joi schema for validating rate-limit update payloads */
const rateLimitUpdateSchema = Joi.object({
  windowMs: Joi.number().integer().min(1000).max(86_400_000).optional(),
  maxRequests: Joi.number().integer().min(1).max(100_000).optional(),
  enabled: Joi.boolean().optional(),
}).min(1);

/**
 * @swagger
 * /api/admin/rate-limit:
 *   get:
 *     tags:
 *       - Admin
 *     summary: Get current global rate-limit configuration
 *     description: Returns the active rate-limit settings (windowMs, maxRequests, enabled).
 *     responses:
 *       '200':
 *         description: Current rate-limit config
 */
router.get("/rate-limit", (_req, res) => {
  res.json({
    success: true,
    rateLimit: appConfig.rateLimit,
  });
});

/**
 * @swagger
 * /api/admin/rate-limit:
 *   put:
 *     tags:
 *       - Admin
 *     summary: Update global rate-limit configuration in real-time
 *     description: >
 *       Merges the supplied fields into the active rate-limit config and
 *       persists the change to config.json so it survives a restart.
 *       All fields are optional — only the provided fields are updated.
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

  // Apply to in-memory config immediately (takes effect on next request)
  Object.assign(appConfig.rateLimit, value);

  // Persist to config.json so the change survives a restart
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
    return res.status(500).json({
      success: false,
      error: "Rate-limit updated in memory but failed to persist to disk",
    });
  }

  console.info(
    "[AdminRateLimit] Rate-limit config updated:",
    appConfig.rateLimit,
  );

  return res.json({
    success: true,
    message: "Rate-limit configuration updated",
    rateLimit: appConfig.rateLimit,
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
    return res.status(500).json({
      success: false,
      error: "Failed to refresh whitelist cache",
    });
  }
});

export default router;
