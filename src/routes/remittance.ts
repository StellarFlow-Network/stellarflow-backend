/**
 * Remittance Routes – Issue #815
 *
 * Exposes GET /api/v1/remittance/history
 *
 * Query parameters
 * ----------------
 * status      string   – Filter by transaction status (PENDING|COMPLETED|FAILED|REVERSED)
 * asset       string   – Filter by asset code (e.g. XLM, USDC)
 * from        string   – ISO-8601 lower bound on createdAt (inclusive)
 * to          string   – ISO-8601 upper bound on createdAt (inclusive)
 * cursor      string   – Opaque pagination cursor from previous response
 * limit       number   – Page size (1–100, default 20)
 *
 * Authentication
 * --------------
 * Requires a valid JWT.  The `userId` is taken from `req.user.userId`
 * (set by jwtMiddleware).  Unauthenticated requests receive 401.
 */

import { Router, Request, Response } from "express";
import { sendApiError } from "../lib/apiError.js";
import {
  RemittanceService,
  VALID_STATUSES,
  RemittanceStatus,
} from "../services/remittanceService";

const router = Router();
const remittanceService = new RemittanceService();

// ---------------------------------------------------------------------------
// Helper – validate ISO date strings
// ---------------------------------------------------------------------------
function parseOptionalDate(
  raw: unknown,
  fieldName: string,
): { date: Date | undefined; error?: string } {
  if (raw === undefined || raw === null || raw === "") {
    return { date: undefined };
  }
  if (typeof raw !== "string") {
    return {
      date: undefined,
      error: `'${fieldName}' must be an ISO-8601 date string`,
    };
  }
  const d = new Date(raw);
  if (isNaN(d.getTime())) {
    return {
      date: undefined,
      error: `'${fieldName}' is not a valid ISO-8601 date`,
    };
  }
  return { date: d };
}

// ---------------------------------------------------------------------------
// GET /history
// ---------------------------------------------------------------------------

/**
 * @swagger
 * /api/v1/remittance/history:
 *   get:
 *     tags:
 *       - Remittance
 *     summary: Get remittance transaction history
 *     description: >
 *       Returns a paginated list of remittance transactions for the authenticated
 *       user.  Results are sorted newest-first.  Use the `nextCursor` field from
 *       the response to advance to the next page.
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: status
 *         schema:
 *           type: string
 *           enum: [PENDING, COMPLETED, FAILED, REVERSED]
 *         description: Filter by transaction status
 *       - in: query
 *         name: asset
 *         schema:
 *           type: string
 *           example: XLM
 *         description: Filter by asset code (case-insensitive)
 *       - in: query
 *         name: from
 *         schema:
 *           type: string
 *           format: date-time
 *           example: "2026-01-01T00:00:00Z"
 *         description: Lower bound on createdAt (inclusive, ISO-8601)
 *       - in: query
 *         name: to
 *         schema:
 *           type: string
 *           format: date-time
 *           example: "2026-12-31T23:59:59Z"
 *         description: Upper bound on createdAt (inclusive, ISO-8601)
 *       - in: query
 *         name: cursor
 *         schema:
 *           type: string
 *         description: Opaque pagination cursor from a previous response
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *           minimum: 1
 *           maximum: 100
 *           default: 20
 *         description: Number of records to return per page (1–100)
 *     responses:
 *       '200':
 *         description: Successful page of remittance transactions
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                   example: true
 *                 data:
 *                   type: array
 *                   items:
 *                     $ref: '#/components/schemas/RemittanceTransaction'
 *                 nextCursor:
 *                   type: string
 *                   nullable: true
 *                   description: Cursor for the next page; null when no more pages exist
 *                 limit:
 *                   type: integer
 *                   example: 20
 *       '400':
 *         description: Invalid query parameter
 *       '401':
 *         description: Authentication required
 *       '500':
 *         description: Internal server error
 *
 * components:
 *   schemas:
 *     RemittanceTransaction:
 *       type: object
 *       properties:
 *         id:
 *           type: string
 *           format: uuid
 *         userId:
 *           type: string
 *         asset:
 *           type: string
 *           example: XLM
 *         senderCurrency:
 *           type: string
 *           example: NGN
 *         receiverCurrency:
 *           type: string
 *           example: KES
 *         amount:
 *           type: number
 *           example: 50000
 *         outputAmount:
 *           type: number
 *           example: 9850
 *         fee:
 *           type: number
 *           example: 150
 *         rate:
 *           type: number
 *           example: 0.197
 *         status:
 *           type: string
 *           enum: [PENDING, COMPLETED, FAILED, REVERSED]
 *         provider:
 *           type: string
 *           nullable: true
 *         stellarTxHash:
 *           type: string
 *           nullable: true
 *         reference:
 *           type: string
 *           nullable: true
 *         errorMessage:
 *           type: string
 *           nullable: true
 *         createdAt:
 *           type: string
 *           format: date-time
 *         updatedAt:
 *           type: string
 *           format: date-time
 */
router.get("/history", async (req: Request, res: Response): Promise<void> => {
  // ---- Authentication check ------------------------------------------------
  const user = (req as Request & { user?: { userId: number; role: string } })
    .user;

  if (!user) {
    sendApiError(
      res,
      401,
      "UNAUTHORIZED",
      "Authentication required to access remittance history",
    );
    return;
  }

  const userId = String(user.userId);

  // ---- Parse & validate query params --------------------------------------

  // status
  const rawStatus = req.query.status as string | undefined;
  if (rawStatus !== undefined && rawStatus !== "") {
    const upperStatus = rawStatus.toUpperCase();
    if (!VALID_STATUSES.includes(upperStatus as RemittanceStatus)) {
      sendApiError(
        res,
        400,
        "BAD_REQUEST",
        `Invalid status '${rawStatus}'. Must be one of: ${VALID_STATUSES.join(", ")}`,
      );
      return;
    }
  }
  const status = rawStatus
    ? (rawStatus.toUpperCase() as RemittanceStatus)
    : undefined;

  // asset
  const rawAsset = req.query.asset as string | undefined;
  const asset =
    rawAsset && rawAsset.length > 0 ? rawAsset.toUpperCase() : undefined;

  // from / to
  const fromResult = parseOptionalDate(req.query.from, "from");
  if (fromResult.error) {
    sendApiError(res, 400, "BAD_REQUEST", fromResult.error);
    return;
  }

  const toResult = parseOptionalDate(req.query.to, "to");
  if (toResult.error) {
    sendApiError(res, 400, "BAD_REQUEST", toResult.error);
    return;
  }

  if (fromResult.date && toResult.date && fromResult.date > toResult.date) {
    sendApiError(
      res,
      400,
      "BAD_REQUEST",
      "'from' must be earlier than or equal to 'to'",
    );
    return;
  }

  // limit
  const rawLimit = req.query.limit as string | undefined;
  let limit: number | undefined;
  if (rawLimit !== undefined && rawLimit !== "") {
    const parsed = parseInt(rawLimit, 10);
    if (isNaN(parsed) || parsed < 1 || parsed > 100) {
      sendApiError(
        res,
        400,
        "BAD_REQUEST",
        "'limit' must be an integer between 1 and 100",
      );
      return;
    }
    limit = parsed;
  }

  // cursor
  const cursor = req.query.cursor as string | undefined;

  // ---- Delegate to service -------------------------------------------------
  try {
    const filters: Parameters<RemittanceService["getHistory"]>[0] = {
      userId,
    };
    if (status !== undefined) filters.status = status;
    if (asset !== undefined) filters.asset = asset;
    if (fromResult.date !== undefined) filters.from = fromResult.date;
    if (toResult.date !== undefined) filters.to = toResult.date;
    if (cursor !== undefined) filters.cursor = cursor;
    if (limit !== undefined) filters.limit = limit;

    const result = await remittanceService.getHistory(filters);

    if (!result.success) {
      // The service only fails here on a bad cursor or DB error
      const statusCode = result.error?.toLowerCase().includes("cursor")
        ? 400
        : 500;
      const code = statusCode === 400 ? "BAD_REQUEST" : "INTERNAL_SERVER_ERROR";
      sendApiError(res, statusCode, code, result.error);
      return;
    }

    res.json({
      success: true,
      data: result.data,
      nextCursor: result.nextCursor,
      limit: result.limit,
    });
  } catch (error) {
    sendApiError(
      res,
      500,
      "INTERNAL_SERVER_ERROR",
      error instanceof Error
        ? error.message
        : "Failed to fetch remittance history",
    );
  }
});

// ---------------------------------------------------------------------------
// GET /savings-comparison
// ---------------------------------------------------------------------------

/**
 * @swagger
 * /api/v1/remittance/savings-comparison:
 *   get:
 *     tags:
 *       - Remittance
 *     summary: Compare remittance fees with traditional providers
 *     description: >
 *       Provides a transparent fee breakdown comparing StellarFlow against major
 *       remittance channels (e.g. Western Union, Wise) and calculates cost savings percentage.
 *     parameters:
 *       - in: query
 *         name: sourceCurrency
 *         required: true
 *         schema:
 *           type: string
 *           example: USD
 *         description: Source currency code
 *       - in: query
 *         name: targetCurrency
 *         required: true
 *         schema:
 *           type: string
 *           example: NGN
 *         description: Target currency code
 *       - in: query
 *         name: amount
 *         required: true
 *         schema:
 *           type: number
 *           example: 1000
 *         description: Transfer amount
 *     responses:
 *       '200':
 *         description: Successful comparison
 *       '400':
 *         description: Invalid query parameters
 *       '500':
 *         description: Internal server error
 */
router.get(
  "/savings-comparison",
  async (req: Request, res: Response): Promise<void> => {
    try {
      const sourceCurrency = req.query.sourceCurrency as string;
      const targetCurrency = req.query.targetCurrency as string;
      const amount = Number(req.query.amount);

      if (!sourceCurrency || typeof sourceCurrency !== "string") {
        sendApiError(res, 400, "BAD_REQUEST", "sourceCurrency is required");
        return;
      }
      if (!targetCurrency || typeof targetCurrency !== "string") {
        sendApiError(res, 400, "BAD_REQUEST", "targetCurrency is required");
        return;
      }
      if (!Number.isFinite(amount) || amount <= 0) {
        sendApiError(
          res,
          400,
          "BAD_REQUEST",
          "amount must be a valid positive number"
        );
        return;
      }

      const result = await remittanceService.getSavingsComparison({
        sourceCurrency,
        targetCurrency,
        amount,
      });

      if (!result.success) {
        sendApiError(
          res,
          500,
          "INTERNAL_SERVER_ERROR",
          result.error || "Failed comparison"
        );
        return;
      }

      res.json({
        success: true,
        data: result.data,
      });
    } catch (error) {
      sendApiError(
        res,
        500,
        "INTERNAL_SERVER_ERROR",
        error instanceof Error ? error.message : "Failed to compare savings"
      );
    }
  }
);

export default router;
