/**
 * Issue #1009 – User Transaction History Export Service in Tax-Compliant
 * Formats.
 *
 * Maps raw swap, deposit and yield events into the standard exchange formats
 * consumed by CoinTracker and Koinly, and streams the resulting CSV so very
 * large account histories do not have to be buffered in memory.
 */

export type TaxExportFormat = "cointracker" | "koinly";
export type TaxEventType = "swap" | "deposit" | "yield";

export interface TaxEventRow {
  date: string;
  type: TaxEventType;
  sentAsset: string | null;
  sentAmount: number | null;
  receivedAsset: string | null;
  receivedAmount: number | null;
  feeAmount: number | null;
  feeAsset: string | null;
  description: string;
  txHash: string | null;
}

export const COINTRACKER_HEADER = [
  "Date",
  "Received Quantity",
  "Received Currency",
  "Sent Quantity",
  "Sent Currency",
  "Fee Amount",
  "Fee Currency",
  "Tag",
  "Description",
] as const;

export const KOINLY_HEADER = [
  "Date",
  "Sent Amount",
  "Sent Currency",
  "Received Amount",
  "Received Currency",
  "Fee Amount",
  "Fee Currency",
  "Net Worth Amount",
  "Net Worth Currency",
  "Label",
  "Description",
  "TxHash",
] as const;

export interface TaxReportRequest {
  address: string;
  format: TaxExportFormat;
  from?: Date;
  to?: Date;
}

export interface TaxReportSummary {
  address: string;
  format: TaxExportFormat;
  eventCount: number;
  from: string | null;
  to: string | null;
  generatedAt: string;
}

export interface TaxReport {
  csv: string;
  rowCount: number;
  summary: TaxReportSummary;
}

/**
 * Minimal structural database contract so the service can be unit-tested with
 * an in-memory stub instead of Prisma.
 */
export interface TaxReportDatabase {
  fxQuote: { findMany(args: any): Promise<any[]> };
  remittanceTransaction: { findMany(args: any): Promise<any[]> };
  harvestExecution: { findMany(args: any): Promise<any[]> };
}

export const COLLECTED_REMITTANCE_STATUSES = ["COMPLETED", "payout_relayed"];

function toDate(value: Date | string | null | undefined): Date | null {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

export function formatTaxDate(value: Date | string | null | undefined): string {
  const date = toDate(value);
  if (!date) return "";
  return date.toISOString().replace("T", " ").slice(0, 19);
}

export function formatAmount(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) {
    return "";
  }
  const trimmed = (value as number)
    .toFixed(12)
    .replace(/0+$/, "")
    .replace(/\.$/, "");
  if (trimmed === "" || trimmed === "-" || trimmed === "-0") return "0";
  return trimmed;
}

export function csvEscape(value: string): string {
  if (/[",\n\r]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

function coinTrackerTag(row: TaxEventRow): string {
  // CoinTracker treats yield/income events with the "Income" tag. Swaps and
  // deposits are plain transfers/exchanges with no special tag.
  return row.type === "yield" ? "Income" : "";
}

function koinlyLabel(row: TaxEventRow): string {
  switch (row.type) {
    case "yield":
      return "reward";
    case "deposit":
      return "deposit";
    case "swap":
    default:
      return "trade";
  }
}

export function toCointrackerRow(row: TaxEventRow): string[] {
  const values = [
    formatTaxDate(row.date),
    formatAmount(row.receivedAmount),
    row.receivedAsset ?? "",
    formatAmount(row.sentAmount),
    row.sentAsset ?? "",
    formatAmount(row.feeAmount),
    row.feeAsset ?? "",
    coinTrackerTag(row),
    row.description,
  ];
  return values.map((value) => csvEscape(String(value)));
}

export function toKoinlyRow(row: TaxEventRow): string[] {
  const values = [
    formatTaxDate(row.date),
    formatAmount(row.sentAmount),
    row.sentAsset ?? "",
    formatAmount(row.receivedAmount),
    row.receivedAsset ?? "",
    formatAmount(row.feeAmount),
    row.feeAsset ?? "",
    "",
    "",
    koinlyLabel(row),
    row.description,
    row.txHash ?? "",
  ];
  return values.map((value) => csvEscape(String(value)));
}

export function renderCsv(rows: TaxEventRow[], format: TaxExportFormat): string {
  const header = format === "koinly" ? KOINLY_HEADER : COINTRACKER_HEADER;
  const renderRow = format === "koinly" ? toKoinlyRow : toCointrackerRow;
  const lines = [header.join(",")];
  for (const row of rows) {
    lines.push(renderRow(row).join(","));
  }
  return `${lines.join("\n")}\n`;
}

export function mapFxQuote(row: any): TaxEventRow | null {
  const date = toDate(row.executedAt ?? row.createdAt);
  if (!date) return null;
  const sender = String(row.senderCurrency ?? "");
  const receiver = String(row.receiverCurrency ?? "");
  return {
    date: date.toISOString(),
    type: "swap",
    sentAsset: sender,
    sentAmount: Number(row.inputAmount),
    receivedAsset: receiver,
    receivedAmount: Number(row.outputAmount),
    feeAmount: Number(row.fee ?? 0),
    feeAsset: sender,
    description: `Swap ${sender} to ${receiver}`,
    txHash: row.txHash ?? null,
  };
}

export function mapRemittance(row: any): TaxEventRow | null {
  const date = toDate(row.createdAt ?? row.updatedAt);
  if (!date) return null;
  const sender = String(row.senderCurrency ?? "");
  const receiver = String(row.receiverCurrency ?? "");
  return {
    date: date.toISOString(),
    type: "deposit",
    sentAsset: sender,
    sentAmount: Number(row.amount),
    receivedAsset: receiver,
    receivedAmount: Number(row.outputAmount),
    feeAmount: Number(row.fee ?? 0),
    feeAsset: sender,
    description: `Remittance deposit ${row.id ?? ""} (${row.status ?? "unknown"})`.trim(),
    txHash: row.stellarTxHash ?? row.reference ?? null,
  };
}

export function mapHarvest(row: any): TaxEventRow | null {
  const date = toDate(row.executedAt ?? row.evaluatedAt ?? row.createdAt);
  if (!date) return null;
  const asset = String(row.asset ?? "");
  const gross = Number(row.yieldAmount ?? 0);
  const net = Number(row.netProfit ?? gross);
  return {
    date: date.toISOString(),
    type: "yield",
    sentAsset: null,
    sentAmount: null,
    receivedAsset: asset,
    receivedAmount: Number.isFinite(net) && net !== 0 ? net : gross,
    feeAmount: Number(row.gasCost ?? 0),
    feeAsset: asset,
    description: `Yield harvest ${row.strategyId ?? ""} (${row.status ?? "unknown"})`.trim(),
    txHash: row.transactionHash ?? null,
  };
}

export class TaxReportService {
  constructor(private readonly db?: TaxReportDatabase) {}

  private async getDb(): Promise<TaxReportDatabase> {
    if (this.db) return this.db;
    const { default: prisma } = await import("../lib/prisma");
    return prisma as unknown as TaxReportDatabase;
  }

  private dateFilter(from?: Date, to?: Date): { gte?: Date; lte?: Date } {
    const filter: { gte?: Date; lte?: Date } = {};
    if (from) filter.gte = from;
    if (to) filter.lte = to;
    return filter;
  }

  async collectRows(request: TaxReportRequest): Promise<TaxEventRow[]> {
    const { address, from, to } = request;
    const rows: TaxEventRow[] = [];
    const db = await this.getDb();

    const [swaps, deposits, harvests] = await Promise.all([
      db.fxQuote.findMany({
        where: {
          userAddress: address,
          status: "EXECUTED",
          executedAt: this.dateFilter(from, to),
        },
        orderBy: { executedAt: "asc" },
      }),
      db.remittanceTransaction.findMany({
        where: {
          status: { in: COLLECTED_REMITTANCE_STATUSES },
          createdAt: this.dateFilter(from, to),
          OR: [
            { userId: address },
            { senderPublicKey: address },
            { recipientPublicKey: address },
          ],
        },
        orderBy: { createdAt: "asc" },
      }),
      db.harvestExecution.findMany({
        where: {
          strategyId: address,
          executedAt: this.dateFilter(from, to),
        },
        orderBy: { executedAt: "asc" },
      }),
    ]);

    for (const row of swaps) {
      const mapped = mapFxQuote(row);
      if (mapped) rows.push(mapped);
    }
    for (const row of deposits) {
      const mapped = mapRemittance(row);
      if (mapped) rows.push(mapped);
    }
    for (const row of harvests) {
      const mapped = mapHarvest(row);
      if (mapped) rows.push(mapped);
    }

    rows.sort((a, b) => a.date.localeCompare(b.date));
    return rows;
  }

  async generateReport(request: TaxReportRequest): Promise<TaxReport> {
    const rows = await this.collectRows(request);
    return {
      csv: renderCsv(rows, request.format),
      rowCount: rows.length,
      summary: this.buildSummary(request, rows.length),
    };
  }

  /**
   * Yield CSV chunks: the header followed by fixed-size batches of rows. Used
   * by the HTTP handler so large histories stream instead of buffering.
   */
  async *streamReport(
    request: TaxReportRequest,
    batchSize = 500,
  ): AsyncGenerator<string> {
    const rows = await this.collectRows(request);
    yield renderCsv([], request.format);
    for (let index = 0; index < rows.length; index += batchSize) {
      yield renderCsv(rows.slice(index, index + batchSize), request.format).split(
        "\n",
      ).slice(1).join("\n");
    }
  }

  buildSummary(request: TaxReportRequest, eventCount: number): TaxReportSummary {
    return {
      address: request.address,
      format: request.format,
      eventCount,
      from: request.from ? request.from.toISOString() : null,
      to: request.to ? request.to.toISOString() : null,
      generatedAt: new Date().toISOString(),
    };
  }
}

export const taxReportService = new TaxReportService();
