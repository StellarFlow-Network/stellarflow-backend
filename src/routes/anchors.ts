/**
 * Anchor Webhook Routes – Issue #931
 *
 * Exposes POST /api/v1/anchors/webhook
 *
 * This endpoint accepts signed webhook payloads from Stellar anchor partners
 * communicating transaction status updates for deposit/withdrawal flows.
 *
 * Request Headers
 * ---------------
 * X-Anchor-Signature: HMAC-SHA256 signature of the raw request body
 *
 * Environment Variables
 * ---------------------
 * ANCHOR_WEBHOOK_SECRET: The shared secret for HMAC validation (required)
 *
 * Authentication
 * ---------------
 * No JWT required. Signature validation provides authentication.
 */

import { Router, Request, Response, json, raw } from "express";
import { sendApiError } from "../lib/apiError.js";
import { anchorWebhookService } from "../services/anchorWebhookService.js";

const router = Router();

// Store raw body for signature validation
router.use(raw({ type: "application/json" }));

/**
 * @swagger
 * /api/v1/anchors/webhook:
 *   post:
 *     tags:
 *       - Anchors
 *     summary: Receive anchor webhook status update
 *     description: >
 *       Processes signed webhook payloads from Stellar anchor partners
 *       indicating the completion status of deposit/withdrawal transactions
 *       (SEP-24 / SEP-31 compliance).
 *
 *       The request must include an X-Anchor-Signature header containing
 *       an HMAC-SHA256 signature of the raw request body. The signature
 *       is validated using the ANCHOR_WEBHOOK_SECRET environment variable.
 *
 *       Upon successful validation and status extraction, the corresponding
 *       RemittanceTransaction is transitioned through the state machine
 *       (e.g., pending_user_transfer -> COMPLETED).
 *     parameters:
 *       - in: header
 *         name: X-Anchor-Signature
 *         required: true
 *         schema:
 *           type: string
 *         description: HMAC-SHA256 signature of the request body (hex-encoded)
 *         example: "a1b2c3d4e5f6g7h8i9j0k1l2m3n4o5p6q7r8s9t0"
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - transaction
 *             properties:
 *               transaction:
 *                 type: object
 *                 required:
 *                   - id
 *                   - status
 *                 properties:
 *                   id:
 *                     type: string
 *                     description: Transaction ID from the anchor
 *                     example: "txn-12345"
 *                   status:
 *                     type: string
 *                     description: >
 *                       Status update (e.g., completed, settled, delivered).
 *                       Will be normalized to internal state machine values.
 *                     example: "completed"
 *                   more_info_url:
 *                     type: string
 *                     description: Optional details URL from anchor
 *                   amount_in:
 *                     type: string
 *                     description: Optional amount received
 *                   amount_out:
 *                     type: string
 *                     description: Optional amount sent
 *     responses:
 *       '200':
 *         description: Webhook processed successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                   example: true
 *                 transactionId:
 *                   type: string
 *                   description: The transaction ID that was updated
 *                   example: "txn-12345"
 *                 previousStatus:
 *                   type: string
 *                   example: "pending_user_transfer"
 *                 newStatus:
 *                   type: string
 *                   example: "COMPLETED"
 *                 message:
 *                   type: string
 *       '400':
 *         description: Invalid payload or missing required fields
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                   example: false
 *                 error:
 *                   type: string
 *       '401':
 *         description: Invalid or missing signature
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                   example: false
 *                 error:
 *                   type: string
 *                   example: "Invalid HMAC signature"
 *       '500':
 *         description: Internal server error during state transition
 */
router.post("/webhook", async (req: Request, res: Response) => {
  try {
    // Extract HMAC signature from headers (case-insensitive)
    const signature = req.headers["x-anchor-signature"] as
      | string
      | undefined;

    // Get the raw body buffer
    const rawBody = req.body as Buffer;

    // Get the webhook secret from environment
    const secret = process.env.ANCHOR_WEBHOOK_SECRET || "";

    if (!secret) {
      return sendApiError(
        res,
        500,
        "CONFIGURATION_ERROR",
        "ANCHOR_WEBHOOK_SECRET is not configured",
      );
    }

    // Validate signature
    if (
      !anchorWebhookService.validateSignature(rawBody, signature, secret)
    ) {
      return sendApiError(
        res,
        401,
        "INVALID_SIGNATURE",
        "Invalid or missing X-Anchor-Signature header",
      );
    }

    // Parse JSON payload
    let payload: unknown;
    try {
      const bodyStr =
        rawBody instanceof Buffer
          ? rawBody.toString("utf8")
          : String(rawBody);
      payload = JSON.parse(bodyStr);
    } catch (_error) {
      return sendApiError(
        res,
        400,
        "INVALID_JSON",
        "Request body is not valid JSON",
      );
    }

    // Process the webhook
    const result = await anchorWebhookService.processWebhook(
      payload,
      signature,
      secret,
    );

    if (!result.success) {
      const statusCode = result.error?.includes("not found") ? 404 : 400;
      return sendApiError(
        res,
        statusCode,
        "WEBHOOK_PROCESSING_ERROR",
        result.error || "Failed to process webhook",
      );
    }

    // Return success response
    res.status(200).json({
      success: true,
      transactionId: result.transactionId,
      previousStatus: result.previousStatus,
      newStatus: result.newStatus,
      message: result.message,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("[Anchor Webhook] Unhandled error:", message, error);
    return sendApiError(
      res,
      500,
      "INTERNAL_SERVER_ERROR",
      "An unexpected error occurred while processing the webhook",
    );
  }
});

export default router;
