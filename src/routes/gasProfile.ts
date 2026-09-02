/**
 * Gas Profiler Routes – Issue #786
 *
 * Mounts under /api/v1/gas-profile
 *
 * Endpoints:
 *   GET /api/v1/gas-profile          – daily average cost per transaction type
 *   GET /api/v1/gas-profile/status   – profiler worker health
 */

import { Router } from "express";
import {
  getGasProfile,
  getGasProfileStatus,
} from "../controllers/gasProfileController.js";

const router = Router();

/**
 * @swagger
 * /api/v1/gas-profile:
 *   get:
 *     tags:
 *       - Gas Profiler
 *     summary: Daily average gas/CPU cost per transaction type
 *     description: >
 *       Returns pre-aggregated daily averages of CPU instructions, fees, and
 *       storage rent for swap, deposit, and withdraw contract calls.
 *     parameters:
 *       - in: query
 *         name: from
 *         schema: { type: string, format: date }
 *         description: Start day (ISO-8601, default 6 days ago UTC)
 *       - in: query
 *         name: to
 *         schema: { type: string, format: date }
 *         description: End day (ISO-8601, default today UTC)
 *       - in: query
 *         name: txType
 *         schema:
 *           type: string
 *           enum: [swap, deposit, withdraw, other, unknown]
 *       - in: query
 *         name: limit
 *         schema: { type: integer, minimum: 1, maximum: 500, default: 100 }
 *     responses:
 *       '200':
 *         description: Daily averages returned successfully
 *       '400':
 *         description: Invalid query parameters
 *       '500':
 *         description: Internal server error
 */
router.get("/", getGasProfile);

/**
 * @swagger
 * /api/v1/gas-profile/status:
 *   get:
 *     tags:
 *       - Gas Profiler
 *     summary: Gas profiler worker status
 *     responses:
 *       '200':
 *         description: Worker status
 */
router.get("/status", getGasProfileStatus);

export default router;
