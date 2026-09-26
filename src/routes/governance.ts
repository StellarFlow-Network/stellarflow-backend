/**
 * Governance Routes
 *
 * Mounted at: /api/v1/governance
 *
 * Endpoints:
 *   GET /api/v1/governance/voters/:account_id  – voter history + delegation tree
 *   GET /api/v1/governance/analytics/turnout   – daily turnout % + category trends
 */

import { Router } from "express";
import { getVoterProfile, governanceVoterCache } from "../controllers/governanceController.js";
import {
  getGovernanceTurnout,
  governanceTurnoutCache,
} from "../controllers/governanceTurnoutController.js";

const router = Router();

/**
 * @swagger
 * /api/v1/governance/voters/{account_id}:
 *   get:
 *     tags:
 *       - Governance
 *     summary: Voter history and delegation tree
 *     description: >
 *       Returns a voter's past on-chain votes (ingested from Soroban GovernanceVoted
 *       events), their active inbound/outbound delegation chain resolved via a
 *       PostgreSQL recursive CTE, and a per-day voting weight trend.
 *     parameters:
 *       - in: path
 *         name: account_id
 *         required: true
 *         schema:
 *           type: string
 *           pattern: '^G[A-Z2-7]{55}$'
 *         description: Stellar public key of the voter
 *       - in: query
 *         name: from
 *         schema: { type: string, format: date-time }
 *         description: "Vote history start (ISO-8601). Default: 90 days ago."
 *       - in: query
 *         name: to
 *         schema: { type: string, format: date-time }
 *         description: "Vote history end (ISO-8601). Default: now."
 *       - in: query
 *         name: limit
 *         schema: { type: integer, minimum: 1, maximum: 200, default: 50 }
 *         description: Max votes per page.
 *       - in: query
 *         name: cursor
 *         schema: { type: integer }
 *         description: Pagination cursor (nextCursor from previous response).
 *       - in: query
 *         name: trendDays
 *         schema: { type: integer, minimum: 7, maximum: 365, default: 90 }
 *         description: Rolling window for weight trend (days).
 *     responses:
 *       '200':
 *         description: Voter profile
 *       '400':
 *         description: Invalid parameters
 *       '404':
 *         description: No governance activity for this account
 *       '500':
 *         description: Internal server error
 */
router.get("/voters/:account_id", governanceVoterCache(), getVoterProfile);

// Swagger docs for this route live on the handler in governanceTurnoutController.ts.
router.get("/analytics/turnout", governanceTurnoutCache(), getGovernanceTurnout);

export default router;
