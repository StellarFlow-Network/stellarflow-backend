import PDFDocument from "pdfkit";
import prisma from "../lib/prisma";

export interface MonthlySummary {
  month: string; // "YYYY-MM"
  totalStellarUpdates: number;
  uptimePercent: number;
  avgPriceStabilityPercent: number;
  perCurrency: Array<{
    currency: string;
    updates: number;
    avgChangePercent: number;
  }>;
  generatedAt: string;
}

/**
 * Derive month boundaries (UTC) from an optional "YYYY-MM" string.
 * Defaults to the current calendar month.
 */
function monthBounds(monthParam?: string): { start: Date; end: Date; label: string } {
  let year: number;
  let month: number; // 0-based

  if (monthParam && /^\d{4}-\d{2}$/.test(monthParam)) {
    const [y, m] = monthParam.split("-").map(Number);
    year = y!;
    month = m! - 1;
  } else {
    const now = new Date();
    year = now.getUTCFullYear();
    month = now.getUTCMonth();
  }

  const start = new Date(Date.UTC(year, month, 1));
  const end = new Date(Date.UTC(year, month + 1, 1));
  const label = `${year}-${String(month + 1).padStart(2, "0")}`;
  return { start, end, label };
}

/**
 * Compute average percentage change between consecutive price records
 * for a given currency within the time window.
 */
async function avgChangeForCurrency(
  currency: string,
  start: Date,
  end: Date,
): Promise<number> {
  const rows = await prisma.priceHistory.findMany({
    where: { currency, timestamp: { gte: start, lt: end } },
    orderBy: { timestamp: "asc" },
    select: { rate: true },
  });

  if (rows.length < 2) return 0;

  let totalChange = 0;
  for (let i = 1; i < rows.length; i++) {
    const prev = Number(rows[i - 1]!.rate);
    const curr = Number(rows[i]!.rate);
    if (prev > 0) totalChange += Math.abs((curr - prev) / prev) * 100;
  }

  return totalChange / (rows.length - 1);
}

export async function buildMonthlySummary(monthParam?: string): Promise<MonthlySummary> {
  const { start, end, label } = monthBounds(monthParam);

  // 1. Total on-chain Stellar submissions in the month
  const totalStellarUpdates = await prisma.onChainPrice.count({
    where: { confirmedAt: { gte: start, lt: end } },
  });

  // 2. Uptime proxy: ratio of hours that had at least one price record
  //    over total hours in the month
  const totalHours = Math.round((end.getTime() - start.getTime()) / 3_600_000);

  const hourlyRows = await prisma.$queryRaw<Array<{ hour: Date }>>`
    SELECT date_trunc('hour', timestamp) AS hour
    FROM "PriceHistory"
    WHERE timestamp >= ${start} AND timestamp < ${end}
    GROUP BY 1
  `;
  const activeHours = hourlyRows.length;
  const uptimePercent =
    totalHours > 0 ? Math.min(100, (activeHours / totalHours) * 100) : 0;

  // 3. Per-currency stats
  const currencies = await prisma.currency.findMany({
    where: { isActive: true },
    select: { code: true },
  });

  const perCurrency = await Promise.all(
    currencies.map(async ({ code }: { code: string }) => {
      const updates = await prisma.priceHistory.count({
        where: { currency: code, timestamp: { gte: start, lt: end } },
      });
      const avgChangePercent = await avgChangeForCurrency(code, start, end);
      return { currency: code, updates, avgChangePercent };
    }),
  );

  // 4. Overall average price stability = mean of per-currency avg changes
  const nonZero = perCurrency.filter((c: { updates: number }) => c.updates >= 2);
  const avgPriceStabilityPercent =
    nonZero.length > 0
      ? nonZero.reduce((s: number, c: { avgChangePercent: number }) => s + c.avgChangePercent, 0) / nonZero.length
      : 0;

  return {
    month: label,
    totalStellarUpdates,
    uptimePercent: parseFloat(uptimePercent.toFixed(2)),
    avgPriceStabilityPercent: parseFloat(avgPriceStabilityPercent.toFixed(4)),
    perCurrency,
    generatedAt: new Date().toISOString(),
  };
}

export function renderHTML(summary: MonthlySummary): string {
  const rows = summary.perCurrency
    .map(
      (c) => `
      <tr>
        <td>${c.currency}</td>
        <td>${c.updates.toLocaleString()}</td>
        <td>${c.avgChangePercent.toFixed(4)}%</td>
      </tr>`,
    )
    .join("");

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <title>StellarFlow Oracle Usage Report – ${summary.month}</title>
  <style>
    body { font-family: Arial, sans-serif; max-width: 860px; margin: 40px auto; color: #1a1a2e; }
    h1 { color: #0f3460; border-bottom: 2px solid #0f3460; padding-bottom: 8px; }
    h2 { color: #16213e; margin-top: 32px; }
    .kpi-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 16px; margin: 24px 0; }
    .kpi { background: #f0f4ff; border-radius: 8px; padding: 20px; text-align: center; }
    .kpi .value { font-size: 2rem; font-weight: bold; color: #0f3460; }
    .kpi .label { font-size: 0.85rem; color: #555; margin-top: 4px; }
    table { width: 100%; border-collapse: collapse; margin-top: 12px; }
    th { background: #0f3460; color: #fff; padding: 10px 14px; text-align: left; }
    td { padding: 9px 14px; border-bottom: 1px solid #e0e0e0; }
    tr:nth-child(even) td { background: #f7f9ff; }
    footer { margin-top: 40px; font-size: 0.8rem; color: #888; }
  </style>
</head>
<body>
  <h1>StellarFlow Oracle Usage Report</h1>
  <p><strong>Period:</strong> ${summary.month} &nbsp;|&nbsp; <strong>Generated:</strong> ${summary.generatedAt}</p>

  <div class="kpi-grid">
    <div class="kpi">
      <div class="value">${summary.totalStellarUpdates.toLocaleString()}</div>
      <div class="label">Total Stellar Updates</div>
    </div>
    <div class="kpi">
      <div class="value">${summary.uptimePercent.toFixed(1)}%</div>
      <div class="label">Oracle Uptime</div>
    </div>
    <div class="kpi">
      <div class="value">${summary.avgPriceStabilityPercent.toFixed(3)}%</div>
      <div class="label">Avg Price Volatility</div>
    </div>
  </div>

  <h2>Per-Currency Breakdown</h2>
  <table>
    <thead>
      <tr><th>Currency</th><th>Price Updates</th><th>Avg Change / Tick</th></tr>
    </thead>
    <tbody>${rows}</tbody>
  </table>

  <footer>Report generated by StellarFlow Backend &mdash; ${summary.generatedAt}</footer>
</body>
</html>`;
}

export function renderPDF(summary: MonthlySummary): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ margin: 50, size: "A4" });
    const chunks: Buffer[] = [];

    doc.on("data", (chunk: Buffer) => chunks.push(chunk));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    // ── Header ──────────────────────────────────────────────────────────────
    doc
      .fontSize(20)
      .fillColor("#0f3460")
      .text("StellarFlow Oracle Usage Report", { align: "center" });

    doc
      .fontSize(11)
      .fillColor("#555")
      .text(`Period: ${summary.month}   |   Generated: ${summary.generatedAt}`, {
        align: "center",
      });

    doc.moveDown(1.5);

    // ── KPI boxes ───────────────────────────────────────────────────────────
    const kpis = [
      { label: "Total Stellar Updates", value: summary.totalStellarUpdates.toLocaleString() },
      { label: "Oracle Uptime", value: `${summary.uptimePercent.toFixed(1)}%` },
      { label: "Avg Price Volatility", value: `${summary.avgPriceStabilityPercent.toFixed(3)}%` },
    ];

    const boxW = 150;
    const boxH = 60;
    const startX = 50;
    const gap = 20;

    kpis.forEach((kpi, i) => {
      const x = startX + i * (boxW + gap);
      const y = doc.y;

      doc.rect(x, y, boxW, boxH).fillAndStroke("#f0f4ff", "#c0c8e8");

      doc
        .fontSize(18)
        .fillColor("#0f3460")
        .text(kpi.value, x, y + 10, { width: boxW, align: "center" });

      doc
        .fontSize(9)
        .fillColor("#555")
        .text(kpi.label, x, y + 34, { width: boxW, align: "center" });
    });

    doc.moveDown(5);

    // ── Per-currency table ───────────────────────────────────────────────────
    doc.fontSize(13).fillColor("#16213e").text("Per-Currency Breakdown", { underline: true });
    doc.moveDown(0.5);

    const colX = [50, 220, 390];
    const headers = ["Currency", "Price Updates", "Avg Change / Tick"];

    // Table header row
    doc.rect(50, doc.y, 500, 22).fill("#0f3460");
    headers.forEach((h, i) => {
      doc
        .fontSize(10)
        .fillColor("#ffffff")
        .text(h, colX[i]!, doc.y - 18, { width: 160 });
    });
    doc.moveDown(0.3);

    // Table data rows
    summary.perCurrency.forEach((row, idx) => {
      const rowY = doc.y;
      if (idx % 2 === 0) doc.rect(50, rowY, 500, 20).fill("#f7f9ff");

      const cells = [
        row.currency,
        row.updates.toLocaleString(),
        `${row.avgChangePercent.toFixed(4)}%`,
      ];
      cells.forEach((cell, i) => {
        doc
          .fontSize(10)
          .fillColor("#1a1a2e")
          .text(cell, colX[i]!, rowY + 4, { width: 160 });
      });
      doc.moveDown(0.6);
    });

    // ── Footer ───────────────────────────────────────────────────────────────
    doc
      .fontSize(8)
      .fillColor("#aaa")
      .text(
        `Report generated by StellarFlow Backend — ${summary.generatedAt}`,
        50,
        doc.page.height - 40,
        { align: "center", width: 500 },
      );

    doc.end();
  });
}
