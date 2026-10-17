import { Request, Response, Router } from "express";
import { sendApiError } from "../lib/apiError.js";
import {
  SOROBAN_FEE_PRIORITIES,
  SorobanFeeEnvelopeError,
  sorobanFeeEnvelopeService,
} from "../services/sorobanFeeEnvelopeService";
import type { SorobanFeePriority } from "../services/sorobanFeeEnvelopeService";

const router = Router();

/**
 * POST /api/v1/soroban/fee-envelope
 *
 * Simulates a proposed Soroban transaction, unpacks its resource footprint
 * (CPU instructions, read/write bytes and ledger entries) and returns a
 * ready-to-sign transaction envelope with optimal fee parameters.
 *
 * @swagger
 * /api/v1/soroban/fee-envelope:
 *   post:
 *     tags: [Soroban]
 *     summary: Build an optimal Soroban transaction fee envelope
 *     description: >
 *       Simulates a proposed transaction XDR on the configured Soroban RPC
 *       endpoint using `simulateTransaction`, unpacks the CPU instruction and
 *       read/write byte footprint, and returns a ready-to-sign base64 envelope
 *       with an optimal inclusion fee and a resource fee that covers the
 *       simulated minimum. A priority tier and an optional resource fee buffer
 *       can be supplied.
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [transaction]
 *             properties:
 *               transaction:
 *                 type: string
 *                 description: Base64-encoded transaction envelope to simulate.
 *               priority:
 *                 type: string
 *                 enum: [low, medium, urgent]
 *                 default: medium
 *                 description: Priority tier used to derive the inclusion fee tip.
 *               resourceFeeBufferPercent:
 *                 type: number
 *                 minimum: 0
 *                 maximum: 100
 *                 default: 0
 *                 description: >
 *                   Extra safety margin applied on top of the simulated
 *                   minimum resource fee, as a percentage.
 *     responses:
 *       200:
 *         description: Fee envelope with resource footprint and fee breakdown.
 *       400:
 *         description: Invalid transaction XDR or request parameters.
 *       422:
 *         description: The transaction failed Soroban simulation.
 */
router.post("/", async (req: Request, res: Response) => {
  const transaction = req.body?.transaction;
  if (typeof transaction !== "string" || transaction.trim().length === 0) {
    sendApiError(
      res,
      400,
      "VALIDATION_ERROR",
      "A base64-encoded 'transaction' envelope is required.",
    );
    return;
  }

  const priority = req.body?.priority;
  if (
    priority !== undefined &&
    priority !== null &&
    !SOROBAN_FEE_PRIORITIES.includes(
      String(priority).toLowerCase() as SorobanFeePriority,
    )
  ) {
    sendApiError(
      res,
      400,
      "VALIDATION_ERROR",
      `'priority' must be one of: ${SOROBAN_FEE_PRIORITIES.join(", ")}.`,
    );
    return;
  }

  try {
    const result = await sorobanFeeEnvelopeService.buildEnvelope({
      transaction,
      priority: req.body?.priority,
      resourceFeeBufferPercent: req.body?.resourceFeeBufferPercent,
    });
    res.json({ success: true, data: result });
  } catch (error: unknown) {
    if (error instanceof SorobanFeeEnvelopeError) {
      sendApiError(
        res,
        error.status,
        error.code,
        error.details ?? error.message,
      );
      return;
    }
    const message =
      error instanceof Error
        ? error.message
        : "Fee envelope construction failed";
    sendApiError(res, 500, "INTERNAL_SERVER_ERROR", message);
  }
});

export default router;
