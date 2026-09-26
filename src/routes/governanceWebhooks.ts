import { Router } from "express";
import {
  listGovernanceWebhookEndpoints,
  registerGovernanceWebhookEndpoint,
  deactivateGovernanceWebhookEndpoint,
  listGovernanceWebhookDeliveries,
  getGovernanceWebhookDeliveryStats,
} from "../controllers/governanceWebhookController.js";

const router = Router();

/**
 * @swagger
 * /api/v1/admin/governance/webhooks:
 *   get:
 *     tags:
 *       - Admin
 *       - Governance Webhooks
 *     summary: List registered governance webhook endpoints
 *     description: >
 *       Returns the external integration partners subscribed to governance
 *       proposal execution status events. Secret values are masked.
 *     parameters:
 *       - in: query
 *         name: includeInactive
 *         schema:
 *           type: boolean
 *           default: false
 *         description: Include deactivated endpoints.
 *     responses:
 *       '200':
 *         description: Endpoints returned successfully
 *       '500':
 *         description: Internal server error
 *   post:
 *     tags:
 *       - Admin
 *       - Governance Webhooks
 *     summary: Register a governance webhook endpoint
 *     description: >
 *       Registers (or updates) an external partner endpoint that will receive
 *       HMAC-SHA256 signed governance proposal status webhooks. When no secret
 *       is supplied one is generated and returned once.
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [url]
 *             properties:
 *               url:
 *                 type: string
 *                 description: HTTPS endpoint that will receive webhook deliveries.
 *               name:
 *                 type: string
 *                 description: Human readable label for the endpoint.
 *               secret:
 *                 type: string
 *                 description: Shared secret used for HMAC-SHA256 signing (min 16 chars).
 *               events:
 *                 type: array
 *                 items:
 *                   type: string
 *                   enum: [proposal.executed, proposal.cancelled, proposal.expired]
 *                 description: Event types to subscribe to. Defaults to all events.
 *               active:
 *                 type: boolean
 *                 default: true
 *     responses:
 *       '201':
 *         description: Endpoint registered successfully
 *       '400':
 *         description: Invalid registration payload
 *       '500':
 *         description: Internal server error
 */
router.get("/", listGovernanceWebhookEndpoints);
router.post("/", registerGovernanceWebhookEndpoint);

/**
 * @swagger
 * /api/v1/admin/governance/webhooks/stats:
 *   get:
 *     tags:
 *       - Admin
 *       - Governance Webhooks
 *     summary: Delivery status summary
 *     description: Aggregate counts of pending, retrying, delivered, and failed webhook deliveries.
 *     responses:
 *       '200':
 *         description: Delivery stats returned successfully
 *       '500':
 *         description: Internal server error
 */
router.get("/stats", getGovernanceWebhookDeliveryStats);

/**
 * @swagger
 * /api/v1/admin/governance/webhooks/deliveries:
 *   get:
 *     tags:
 *       - Admin
 *       - Governance Webhooks
 *     summary: List governance webhook delivery history
 *     description: >
 *       Returns the delivery history log for governance proposal status
 *       webhooks, including attempts, response status, and errors.
 *     parameters:
 *       - in: query
 *         name: endpointId
 *         schema:
 *           type: string
 *           format: uuid
 *         description: Filter by webhook endpoint id.
 *       - in: query
 *         name: eventType
 *         schema:
 *           type: string
 *           enum: [proposal.executed, proposal.cancelled, proposal.expired]
 *         description: Filter by event type.
 *       - in: query
 *         name: proposalId
 *         schema:
 *           type: string
 *         description: Filter by proposal id.
 *       - in: query
 *         name: status
 *         schema:
 *           type: string
 *           enum: [pending, retrying, delivered, failed]
 *         description: Filter by delivery status.
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *           default: 50
 *           minimum: 1
 *           maximum: 200
 *       - in: query
 *         name: offset
 *         schema:
 *           type: integer
 *           default: 0
 *           minimum: 0
 *     responses:
 *       '200':
 *         description: Delivery history returned successfully
 *       '500':
 *         description: Internal server error
 */
router.get("/deliveries", listGovernanceWebhookDeliveries);

/**
 * @swagger
 * /api/v1/admin/governance/webhooks/{id}:
 *   delete:
 *     tags:
 *       - Admin
 *       - Governance Webhooks
 *     summary: Deactivate a governance webhook endpoint
 *     description: Stops future deliveries to the endpoint without deleting its history.
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *           format: uuid
 *     responses:
 *       '200':
 *         description: Endpoint deactivated successfully
 *       '400':
 *         description: Invalid endpoint id
 *       '404':
 *         description: Endpoint not found or already inactive
 *       '500':
 *         description: Internal server error
 */
router.delete("/:id", deactivateGovernanceWebhookEndpoint);

export default router;
