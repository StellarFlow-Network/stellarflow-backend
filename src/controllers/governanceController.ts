/**
 * Governance Controller
 *
 * Handles: GET /api/v1/governance/voters/:account_id
 *
 * Returns the voter's past votes, active delegation chains, and voting
 * weight trend – all fetched from PostgreSQL via voterHistoryService.
 *
 * @swagger
 * tags:
 *   - name: Governance
 *     description: Voter history and delegation management
 */

import { Request, Response } from "express";
import { sendApiError } from "../lib/apiError.js";
import {
  getVoteHistory,
  getDelegationTree,
  getWeightTrend,
} from "../services/voterHistoryService.js";
import { CACHE_CONFIG, CACHE_KEYS } from "../config/redis.config.js";
import { cacheMiddleware } from "../cache/CacheMiddleware.js";

// ─── Constants ────────────────────────────────────────────────────────────────

const STELLAR_ACCOUNT_RE = /^G[A-Z2-7]{55}$/;
const MAX_LIMIT       = 200;
const DEFAULT_LIMIT   = 50;
const MAX_TREND_DAYS  = 365;
const DEFAULT_TREND_DAYS = 90;
const MAX_DATE_RANGE_MS  = 365 * 24 * 60 * 60 * 1000; // 1 year

// ─── Cache middleware factory (reused across the route) ───────────────────────

export function governanceVoterCache() {
  return cacheMiddleware({
    ttl: CACHE_CONFIG.ttl.governance,
    keyGenerator: (req: Request) => {
      const { account_id } = req.params;
      // Include query string in cache key so different filters don't collide
      const qs = new URLSearchParams(req.query as Record<string, string>).toString();
      return CACHE_KEYS.governance.voter(`${account_id}:${qs}`);
    },
  });
}

// ─── Handler ──────────────────────────────────────────────────────────────────

/**
 * GET /api/v1/governance/voters/:account_id
 *
 * @swagger
 * /api/v1/governance/voters/{account_id}:
 *   get:
 *     tags:
 *       - Governance
 *     summary: Voter history and delegation tree
 *     description: >
 *       Returns a voter's past on-chain votes (ingested from Soroban events),
 *       their active inbound/outbound delegation chain (resolved via a recursive
 *       CTE), and a per-day voting weight trend.
 *     parameters:
 *       - in: path
 *         name: account_id
 *         required: true
 *         schema:
 *           type: string
 *           pattern: '^G[A-Z2-7]{55}$'
 *         description: Stellar public key of the voter account
 *         example: GABC123...XYZ
 *       - in: query
 *         name: from
 *         schema:
 *           type: string
 *           format: date-time
 *         description: "Start of vote history window (ISO-8601). Default: 90 days ago."
 *       - in: query
 *         name: to
 *         schema:
 *           type: string
 *           format: date-time
 *         description: "End of vote history window (ISO-8601). Default: now."
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *           minimum: 1
 *           maximum: 200
 *           default: 50
 *         description: Maximum number of votes to return per page.
 *       - in: query
 *         name: cursor
 *         schema:
 *           type: integer
 *         description: Pagination cursor (vote id from the previous page's nextCursor).
 *       - in: query
 *         name: trendDays
 *         schema:
 *           type: integer
 *           minimum: 7
 *           maximum: 365
 *           default: 90
 *         description: Rolling window in days for the voting weight trend.
 *     responses:
 *       '200':
 *         description: Voter profile returned successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 data:
 *                   type: object
 *                   properties:
 *                     accountId:
 *                       type: string
 *                     voteHistory:
 *                       type: object
 *                       properties:
 *                         total:
 *                           type: integer
 *                         nextCursor:
 *                           type: integer
 *                           nullable: true
 *                         items:
 *                           type: array
 *                           items:
 *                             type: object
 *                             properties:
 *                               voteId:        { type: integer }
 *                               proposalId:    { type: string }
 *                               proposalTitle: { type: string, nullable: true }
 *                               proposalStatus:{ type: string }
 *                               choice:        { type: string, enum: [For, Against, Abstain] }
 *                               weight:        { type: string }
 *                               votedAt:       { type: string, format: date-time }
 *                               txHash:        { type: string, nullable: true }
 *                     delegationTree:
 *                       type: object
 *                       properties:
 *                         outbound:
 *                           type: array
 *                           items: { $ref: '#/components/schemas/DelegationNode' }
 *                         inbound:
 *                           type: array
 *                           items: { $ref: '#/components/schemas/DelegationNode' }
 *                         totalDelegatedInboundWeight:
 *                           type: string
 *                     weightTrend:
 *                       type: array
 *                       items:
 *                         type: object
 *                         properties:
 *                           date:       { type: string, format: date }
 *                           avgWeight:  { type: string }
 *                           voteCount:  { type: integer }
 *       '400':
 *         description: Invalid parameters
 *       '404':
 *         description: No voting history found for the account
 *       '500':
 *         description: Internal server error
 */
export async function getVoterProfile(
  req: Request,
  res: Response,
): Promise<void> {
  try {
    // ── 1. Validate path param ──────────────────────────────────────────────
    const account_id = typeof req.params.account_id === "string"
      ? req.params.account_id
      : undefined;

    if (!account_id || !STELLAR_ACCOUNT_RE.test(account_id)) {
      sendApiError(
        res,
        400,
        "BAD_REQUEST",
        "account_id must be a valid Stellar public key (G followed by 55 base-32 characters).",
      );
      return;
    }

    // ── 2. Parse & validate query params ────────────────────────────────────
    const now = new Date();

    const toDate = req.query.to
      ? new Date(req.query.to as string)
      : now;
    if (isNaN(toDate.getTime())) {
      sendApiError(res, 400, "BAD_REQUEST", "Invalid `to` date — use ISO-8601 format.");
      return;
    }

    const fromDate = req.query.from
      ? new Date(req.query.from as string)
      : new Date(toDate.getTime() - DEFAULT_TREND_DAYS * 24 * 60 * 60 * 1000);
    if (isNaN(fromDate.getTime())) {
      sendApiError(res, 400, "BAD_REQUEST", "Invalid `from` date — use ISO-8601 format.");
      return;
    }

    if (fromDate >= toDate) {
      sendApiError(res, 400, "BAD_REQUEST", "`from` must be earlier than `to`.");
      return;
    }
    if (toDate.getTime() - fromDate.getTime() > MAX_DATE_RANGE_MS) {
      sendApiError(res, 400, "BAD_REQUEST", "Date range cannot exceed 1 year.");
      return;
    }

    let limit = DEFAULT_LIMIT;
    if (req.query.limit !== undefined) {
      const parsed = parseInt(req.query.limit as string, 10);
      if (isNaN(parsed) || parsed < 1) {
        sendApiError(res, 400, "BAD_REQUEST", "`limit` must be a positive integer.");
        return;
      }
      limit = Math.min(parsed, MAX_LIMIT);
    }

    const cursor = req.query.cursor
      ? parseInt(req.query.cursor as string, 10)
      : undefined;
    if (cursor !== undefined && (isNaN(cursor) || cursor < 1)) {
      sendApiError(res, 400, "BAD_REQUEST", "`cursor` must be a positive integer.");
      return;
    }

    let trendDays = DEFAULT_TREND_DAYS;
    if (req.query.trendDays !== undefined) {
      const parsed = parseInt(req.query.trendDays as string, 10);
      if (isNaN(parsed) || parsed < 7 || parsed > MAX_TREND_DAYS) {
        sendApiError(
          res,
          400,
          "BAD_REQUEST",
          "`trendDays` must be an integer between 7 and 365.",
        );
        return;
      }
      trendDays = parsed;
    }

    // ── 3. Fetch data in parallel ────────────────────────────────────────────
    const voteHistoryOptions = { from: fromDate, to: toDate, limit };
    if (cursor !== undefined) {
      Object.assign(voteHistoryOptions, { cursor });
    }

    const [voteHistory, delegationTree, weightTrend] = await Promise.all([
      getVoteHistory(account_id, voteHistoryOptions),
      getDelegationTree(account_id),
      getWeightTrend(account_id, trendDays),
    ]);

    // ── 4. 404 if no voting activity at all ─────────────────────────────────
    if (voteHistory.total === 0 && delegationTree.inbound.length === 0 && delegationTree.outbound.length === 0) {
      sendApiError(
        res,
        404,
        "NOT_FOUND",
        `No governance activity found for account ${account_id}.`,
      );
      return;
    }

    // ── 5. Respond ──────────────────────────────────────────────────────────
    res.json({
      success: true,
      data: {
        accountId: account_id,
        voteHistory,
        delegationTree,
        weightTrend,
      },
    });
  } catch (err) {
    console.error("[GovernanceController] getVoterProfile error:", err);
    sendApiError(
      res,
      500,
      "INTERNAL_SERVER_ERROR",
      err instanceof Error ? err.message : undefined,
    );
  }
}
