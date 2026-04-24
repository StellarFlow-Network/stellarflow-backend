import { Router } from "express";
import { buildMonthlySummary, renderHTML, renderPDF } from "../services/reportService";

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
  const format = (req.query.format as string | undefined)?.toLowerCase() ?? "html";
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
      error: error instanceof Error ? error.message : "Failed to generate report",
    });
  }
});

export default router;
