/**
 * Governance Turnout Controller (Issue #1064)
 *
 * Handles: GET /api/v1/governance/analytics/turnout
 *
 * Validates the query string and serves daily voting-turnout percentages and
 * per-category participation trends from the TimescaleDB continuous aggregate.
 */

import { Request, Response } from "express";
import { sendApiError } from "../lib/apiError.js";
import { CACHE_CONFIG, CACHE_KEYS } from "../config/redis.config.js";
import { cacheMiddleware } from "../cache/CacheMiddleware.js";
import {
  getTurnoutAnalytics,
  type TurnoutQuery,
} from "../services/governanceTurnoutService.js";
import type { TurnoutAnalytics } from "../analytics/governanceTurnout.js";

// ─── Constants ────────────────────────────────────────────────────────────────

export const DEFAULT_RANGE_DAYS = 90;
export const MAX_RANGE_DAYS = 365;
const DAY_MS = 24 * 60 * 60 * 1000;
const CATEGORY_RE = /^[A-Za-z0-9_.:\- ]{1,64}$/;

export const TURNOUT_DEFINITION =
  "turnoutPct = distinct voters on the day / distinct accounts that have voted " +
  "on or before that day, in any category, × 100. Days without votes are omitted.";

// ─── Cache ────────────────────────────────────────────────────────────────────

export function governanceTurnoutCache() {
  return cacheMiddleware({
    ttl: CACHE_CONFIG.ttl.governance,
    keyGenerator: (req: Request) => {
      const qs = new URLSearchParams(req.query as Record<string, string>).toString();
      return CACHE_KEYS.governance.turnout(qs);
    },
  });
}

// ─── Query parsing ────────────────────────────────────────────────────────────

export type ParsedTurnoutQuery =
  | { ok: true; value: TurnoutQuery }
  | { ok: false; message: string };

const startOfUtcDay = (d: Date): Date =>
  new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));

export function parseTurnoutQuery(
  query: Request["query"],
  now: Date = new Date(),
): ParsedTurnoutQuery {
  const rawTo = query.to;
  const rawFrom = query.from;
  const rawCategory = query.category;

  if (
    [rawTo, rawFrom, rawCategory].some(
      (v) => v !== undefined && typeof v !== "string",
    )
  ) {
    return { ok: false, message: "`from`, `to` and `category` must be single string values." };
  }

  const to = rawTo ? new Date(rawTo as string) : now;
  if (isNaN(to.getTime())) {
    return { ok: false, message: "Invalid `to` date — use ISO-8601 format." };
  }

  const from = rawFrom
    ? new Date(rawFrom as string)
    : new Date(to.getTime() - DEFAULT_RANGE_DAYS * DAY_MS);
  if (isNaN(from.getTime())) {
    return { ok: false, message: "Invalid `from` date — use ISO-8601 format." };
  }

  if (from >= to) {
    return { ok: false, message: "`from` must be earlier than `to`." };
  }
  if (to.getTime() - from.getTime() > MAX_RANGE_DAYS * DAY_MS) {
    return { ok: false, message: `Date range cannot exceed ${MAX_RANGE_DAYS} days.` };
  }

  let category: string | undefined;
  if (rawCategory !== undefined) {
    if (!CATEGORY_RE.test(rawCategory as string)) {
      return {
        ok: false,
        message:
          "`category` must be 1–64 characters of letters, digits, space or _ . : -.",
      };
    }
    category = rawCategory as string;
  }

  // Aggregate buckets are UTC day starts, so include the whole first day.
  const value: TurnoutQuery = { from: startOfUtcDay(from), to };
  if (category !== undefined) value.category = category;
  return { ok: true, value };
}

// ─── Handler ──────────────────────────────────────────────────────────────────

type TurnoutFetcher = (query: TurnoutQuery) => Promise<TurnoutAnalytics>;

/** Factory so tests can inject a fake fetcher instead of a database. */
export function createTurnoutHandler(fetchTurnout: TurnoutFetcher = getTurnoutAnalytics) {
  return async function getGovernanceTurnout(
    req: Request,
    res: Response,
  ): Promise<void> {
    const parsed = parseTurnoutQuery(req.query);
    if (!parsed.ok) {
      sendApiError(res, 400, "BAD_REQUEST", parsed.message);
      return;
    }

    try {
      const analytics = await fetchTurnout(parsed.value);
      res.json({
        success: true,
        data: {
          range: {
            from: parsed.value.from.toISOString(),
            to: parsed.value.to.toISOString(),
          },
          category: parsed.value.category ?? null,
          definition: TURNOUT_DEFINITION,
          ...analytics,
        },
      });
    } catch (err) {
      console.error("[GovernanceTurnoutController] error:", err);
      sendApiError(
        res,
        500,
        "INTERNAL_SERVER_ERROR",
        err instanceof Error ? err.message : undefined,
      );
    }
  };
}

/**
 * GET /api/v1/governance/analytics/turnout
 *
 * @swagger
 * /api/v1/governance/analytics/turnout:
 *   get:
 *     tags:
 *       - Governance
 *     summary: Historical governance voting turnout
 *     description: >
 *       Daily voting turnout percentages and per-category participation trends,
 *       served from a TimescaleDB continuous aggregate. Turnout is the share of
 *       the participating voter base (accounts that have voted on or before that
 *       day) that voted on the day. Days without votes are omitted.
 *     parameters:
 *       - in: query
 *         name: from
 *         schema: { type: string, format: date-time }
 *         description: "Range start (ISO-8601). Default: 90 days before `to`."
 *       - in: query
 *         name: to
 *         schema: { type: string, format: date-time }
 *         description: "Range end (ISO-8601). Default: now."
 *       - in: query
 *         name: category
 *         schema: { type: string, maxLength: 64 }
 *         description: Restrict to one proposal category (the proposal action type).
 *     responses:
 *       '200':
 *         description: Turnout series and category trends
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success: { type: boolean }
 *                 data:
 *                   type: object
 *                   properties:
 *                     range:
 *                       type: object
 *                       properties:
 *                         from: { type: string, format: date-time }
 *                         to:   { type: string, format: date-time }
 *                     category:   { type: string, nullable: true }
 *                     definition: { type: string }
 *                     overall:
 *                       type: array
 *                       description: One point per day, all categories combined.
 *                       items: { $ref: '#/components/schemas/TurnoutPoint' }
 *                     byCategory:
 *                       type: array
 *                       description: One point per day and category.
 *                       items:
 *                         allOf:
 *                           - $ref: '#/components/schemas/TurnoutPoint'
 *                           - type: object
 *                             properties:
 *                               category: { type: string }
 *                     categories:
 *                       type: array
 *                       description: Participation trend per category.
 *                       items:
 *                         type: object
 *                         properties:
 *                           category:         { type: string }
 *                           activeDays:       { type: integer }
 *                           totalVotes:       { type: integer }
 *                           avgTurnoutPct:    { type: number }
 *                           peakTurnoutPct:   { type: number }
 *                           latestTurnoutPct: { type: number }
 *                           trend:
 *                             type: object
 *                             properties:
 *                               direction:
 *                                 type: string
 *                                 enum: [up, down, flat, insufficient_data]
 *                               changePct: { type: number }
 *       '400':
 *         description: Invalid parameters
 *       '500':
 *         description: Internal server error
 * components:
 *   schemas:
 *     TurnoutPoint:
 *       type: object
 *       properties:
 *         date:           { type: string, format: date }
 *         voters:         { type: integer }
 *         votes:          { type: integer }
 *         totalWeight:    { type: string }
 *         eligibleVoters: { type: integer }
 *         turnoutPct:     { type: number }
 */
export const getGovernanceTurnout = createTurnoutHandler();
