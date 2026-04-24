import { Router } from "express";
import {
  buildMonthlySummary,
  renderHTML,
  renderPDF,
} from "../services/reportService";
import { updateSecretKey } from "../services/secretManager";

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

export default router;
