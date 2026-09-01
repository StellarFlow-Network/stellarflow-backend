/**
 * RemittanceService – Issue #815
 *
 * Business logic for querying user remittance transaction history.
 * Implements cursor-based pagination (keyed on `createdAt` + `id`) to
 * support high-volume accounts without offset degradation.
 *
 * Supported filters
 * -----------------
 * - status      – one of PENDING | COMPLETED | FAILED | REVERSED
 * - asset       – asset code (e.g. "XLM", "USDC", "NGN")
 * - from / to   – ISO-8601 date-range bounds on `createdAt`
 *
 * Pagination
 * ----------
 * Clients send `cursor` (a base64-encoded `{createdAt, id}` pair) to advance
 * through pages.  The response includes `nextCursor` when more rows exist.
 */

import prisma from "../lib/prisma";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Valid transaction status values. */
export const VALID_STATUSES = [
  "PENDING",
  "COMPLETED",
  "FAILED",
  "REVERSED",
] as const;

export type RemittanceStatus = (typeof VALID_STATUSES)[number];

/** Default and maximum page sizes. */
export const DEFAULT_PAGE_SIZE = 20;
export const MAX_PAGE_SIZE = 100;

// ---------------------------------------------------------------------------
// Interfaces
// ---------------------------------------------------------------------------

export interface RemittanceHistoryFilters {
  /** Authenticated user ID – required; scopes all queries. */
  userId: string;
  /** Optional status filter. */
  status?: RemittanceStatus;
  /** Optional asset code filter (case-insensitive). */
  asset?: string;
  /** Optional lower bound on createdAt (inclusive). */
  from?: Date;
  /** Optional upper bound on createdAt (inclusive). */
  to?: Date;
  /** Opaque cursor returned by a previous page response. */
  cursor?: string;
  /** Number of records to return (1–100, default 20). */
  limit?: number;
}

export interface RemittanceCursorPayload {
  createdAt: string; // ISO-8601
  id: string;
}

export interface RemittanceTransactionRecord {
  id: string;
  userId: string;
  asset: string;
  senderCurrency: string;
  receiverCurrency: string;
  amount: number;
  outputAmount: number;
  fee: number;
  rate: number;
  status: string;
  provider: string | null;
  stellarTxHash: string | null;
  reference: string | null;
  errorMessage: string | null;
  createdAt: string; // ISO-8601
  updatedAt: string; // ISO-8601
}

export interface RemittanceHistoryResult {
  success: boolean;
  data: RemittanceTransactionRecord[];
  /** Opaque cursor to pass as `cursor` in the next request. Absent on last page. */
  nextCursor: string | null;
  /** Effective page size used for this request. */
  limit: number;
  error?: string;
}

// ---------------------------------------------------------------------------
// Cursor helpers
// ---------------------------------------------------------------------------

/**
 * Encode a cursor pair to an opaque base64 string.
 */
export function encodeCursor(payload: RemittanceCursorPayload): string {
  return Buffer.from(JSON.stringify(payload)).toString("base64url");
}

/**
 * Decode and validate an incoming cursor string.
 * Returns null when the string is malformed or missing required fields.
 */
export function decodeCursor(raw: string): RemittanceCursorPayload | null {
  try {
    const parsed: unknown = JSON.parse(
      Buffer.from(raw, "base64url").toString("utf8"),
    );

    if (
      typeof parsed !== "object" ||
      parsed === null ||
      typeof (parsed as Record<string, unknown>).createdAt !== "string" ||
      typeof (parsed as Record<string, unknown>).id !== "string"
    ) {
      return null;
    }

    const { createdAt, id } = parsed as RemittanceCursorPayload;

    // Validate that createdAt is a real ISO date
    if (isNaN(new Date(createdAt).getTime())) {
      return null;
    }

    return { createdAt, id };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Service class
// ---------------------------------------------------------------------------

export class RemittanceService {
  /**
   * Fetch a page of remittance transactions for a given user.
   *
   * Uses a two-field cursor on `(createdAt DESC, id ASC)` to guarantee stable
   * pagination even when two transactions share the same createdAt timestamp.
   *
   * The query fetches `limit + 1` rows; if the extra row exists the caller
   * knows another page is available and the extra row is stripped before
   * returning so clients always receive exactly `limit` rows or fewer.
   */
  async getHistory(
    filters: RemittanceHistoryFilters,
  ): Promise<RemittanceHistoryResult> {
    try {
      const limit = Math.min(
        Math.max(Number(filters.limit ?? DEFAULT_PAGE_SIZE), 1),
        MAX_PAGE_SIZE,
      );

      // Build `where` clause ---------------------------------------------------

      const where: Record<string, any> = {
        userId: filters.userId,
      };

      if (filters.status) {
        where.status = filters.status;
      }

      if (filters.asset) {
        where.asset = filters.asset.toUpperCase();
      }

      // Date-range filter on createdAt
      const createdAtFilter: Record<string, Date> = {};
      if (filters.from) {
        createdAtFilter.gte = filters.from;
      }
      if (filters.to) {
        createdAtFilter.lte = filters.to;
      }
      if (Object.keys(createdAtFilter).length > 0) {
        where.createdAt = createdAtFilter;
      }

      // Cursor condition -------------------------------------------------------
      //
      // We page in descending createdAt order (newest first).  Ties are broken
      // by ascending id so rows are stable when multiple transactions share a
      // millisecond timestamp.
      //
      // Cursor semantics: "give me rows where
      //   createdAt < cursor.createdAt
      //   OR (createdAt == cursor.createdAt AND id > cursor.id)"
      //
      // This is the standard compound-cursor pattern for (DESC, ASC) ordering.

      let cursorWhere: Record<string, unknown> | undefined;
      if (filters.cursor) {
        const decoded = decodeCursor(filters.cursor);
        if (!decoded) {
          return {
            success: false,
            data: [],
            nextCursor: null,
            limit,
            error: "Invalid cursor: could not decode pagination token",
          };
        }

        const cursorDate = new Date(decoded.createdAt);
        cursorWhere = {
          OR: [
            { createdAt: { lt: cursorDate } },
            {
              createdAt: { equals: cursorDate },
              id: { gt: decoded.id },
            },
          ],
        };
      }

      const finalWhere = cursorWhere ? { AND: [where, cursorWhere] } : where;

      // Fetch limit + 1 to detect next page -----------------------------------
      const rows = await prisma.remittanceTransaction.findMany({
        where: finalWhere,
        orderBy: [{ createdAt: "desc" }, { id: "asc" }],
        take: limit + 1,
        select: {
          id: true,
          userId: true,
          asset: true,
          senderCurrency: true,
          receiverCurrency: true,
          amount: true,
          outputAmount: true,
          fee: true,
          rate: true,
          status: true,
          provider: true,
          stellarTxHash: true,
          reference: true,
          errorMessage: true,
          createdAt: true,
          updatedAt: true,
        },
      });

      const hasMore = rows.length > limit;
      const pageRows = hasMore ? rows.slice(0, limit) : rows;

      // Build nextCursor from the last row of the current page ----------------
      let nextCursor: string | null = null;
      if (hasMore && pageRows.length > 0) {
        const last = pageRows[pageRows.length - 1];
        if (last) {
          nextCursor = encodeCursor({
            createdAt: last.createdAt.toISOString(),
            id: last.id,
          });
        }
      }

      // Type helper for the selected row shape returned by Prisma
      type SelectedRow = {
        id: string;
        userId: string;
        asset: string;
        senderCurrency: string;
        receiverCurrency: string;
        amount: { valueOf(): number } | number;
        outputAmount: { valueOf(): number } | number;
        fee: { valueOf(): number } | number;
        rate: { valueOf(): number } | number;
        status: string;
        provider: string | null;
        stellarTxHash: string | null;
        reference: string | null;
        errorMessage: string | null;
        createdAt: Date;
        updatedAt: Date;
      };

      const data: RemittanceTransactionRecord[] = (
        pageRows as unknown as SelectedRow[]
      ).map((r) => ({
        id: r.id,
        userId: r.userId,
        asset: r.asset,
        senderCurrency: r.senderCurrency,
        receiverCurrency: r.receiverCurrency,
        amount: Number(r.amount),
        outputAmount: Number(r.outputAmount),
        fee: Number(r.fee),
        rate: Number(r.rate),
        status: r.status,
        provider: r.provider ?? null,
        stellarTxHash: r.stellarTxHash ?? null,
        reference: r.reference ?? null,
        errorMessage: r.errorMessage ?? null,
        createdAt: r.createdAt.toISOString(),
        updatedAt: r.updatedAt.toISOString(),
      }));

      return { success: true, data, nextCursor, limit };
    } catch (error) {
      return {
        success: false,
        data: [],
        nextCursor: null,
        limit: filters.limit ?? DEFAULT_PAGE_SIZE,
        error:
          error instanceof Error
            ? error.message
            : "Failed to fetch remittance history",
      };
    }
  }
}
