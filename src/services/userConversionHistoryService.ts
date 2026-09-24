import prisma from "../lib/prisma";

export const DEFAULT_CONVERSION_HISTORY_LIMIT = 20;
export const MAX_CONVERSION_HISTORY_LIMIT = 100;

export interface ConversionHistoryFilters {
  address: string;
  currency?: string;
  fromCurrency?: string;
  toCurrency?: string;
  cursor?: string;
  limit?: number;
}

export interface ConversionHistoryResult {
  data: Array<{
    id: string;
    senderCurrency: string;
    receiverCurrency: string;
    inputAmount: number;
    outputAmount: number;
    rate: number;
    fee: number;
    executedAt: string;
  }>;
  nextCursor: string | null;
  limit: number;
}

function encodeCursor(executedAt: Date, id: string): string {
  return Buffer.from(
    JSON.stringify({ executedAt: executedAt.toISOString(), id }),
  ).toString("base64url");
}

function decodeCursor(cursor: string): { executedAt: Date; id: string } | null {
  try {
    const parsed = JSON.parse(
      Buffer.from(cursor, "base64url").toString("utf8"),
    ) as { executedAt?: unknown; id?: unknown };
    if (typeof parsed.executedAt !== "string" || typeof parsed.id !== "string") {
      return null;
    }
    const executedAt = new Date(parsed.executedAt);
    return Number.isNaN(executedAt.getTime())
      ? null
      : { executedAt, id: parsed.id };
  } catch {
    return null;
  }
}

export class UserConversionHistoryService {
  async getHistory(
    filters: ConversionHistoryFilters,
  ): Promise<ConversionHistoryResult> {
    const limit = Math.min(
      Math.max(Number(filters.limit ?? DEFAULT_CONVERSION_HISTORY_LIMIT), 1),
      MAX_CONVERSION_HISTORY_LIMIT,
    );
    const fromCurrency = filters.fromCurrency?.trim().toUpperCase();
    const toCurrency = filters.toCurrency?.trim().toUpperCase();
    const currency = filters.currency?.trim().toUpperCase();

    const where: Record<string, unknown> = {
      userAddress: filters.address,
      status: "EXECUTED",
      executedAt: { not: null },
      ...(fromCurrency ? { senderCurrency: fromCurrency } : {}),
      ...(toCurrency ? { receiverCurrency: toCurrency } : {}),
      ...(currency
        ? {
            OR: [
              { senderCurrency: currency },
              { receiverCurrency: currency },
            ],
          }
        : {}),
    };

    if (filters.cursor) {
      const decoded = decodeCursor(filters.cursor);
      if (!decoded) {
        throw new Error("Invalid cursor");
      }
      where.AND = [
        {
          OR: [
            { executedAt: { lt: decoded.executedAt } },
            { executedAt: decoded.executedAt, id: { gt: decoded.id } },
          ],
        },
      ];
    }

    const rows = await prisma.fxQuote.findMany({
      where,
      orderBy: [{ executedAt: "desc" }, { id: "asc" }],
      take: limit + 1,
      select: {
        id: true,
        senderCurrency: true,
        receiverCurrency: true,
        inputAmount: true,
        outputAmount: true,
        rate: true,
        fee: true,
        executedAt: true,
      },
    });

    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    const last = page[page.length - 1];

    return {
      data: page.map((row) => ({
        id: row.id,
        senderCurrency: row.senderCurrency,
        receiverCurrency: row.receiverCurrency,
        inputAmount: Number(row.inputAmount),
        outputAmount: Number(row.outputAmount),
        rate: Number(row.rate),
        fee: Number(row.fee),
        executedAt: row.executedAt?.toISOString() ?? "",
      })),
      nextCursor:
        hasMore && last?.executedAt
          ? encodeCursor(last.executedAt, last.id)
          : null,
      limit,
    };
  }
}