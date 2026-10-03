import { Router } from "express";
import { createEventBusHandlers } from "../controllers/eventBusController";
import { requireAdmin } from "../middleware/roleMatrixMiddleware";

/**
 * Issue #1055 – Internal event bus metrics and queue backpressure alert bot.
 *
 * Read-only views over the last polling cycle: a dashboard refresh must never
 * add broker load while the broker is the thing that is struggling.
 */
const router = Router();
const handlers = createEventBusHandlers();

/**
 * @swagger
 * /api/v1/admin/event-bus/queues:
 *   get:
 *     tags:
 *       - Admin
 *     summary: Event bus queue backlog
 *     description: >
 *       Returns the pending message count, unacknowledged count, consumer count
 *       and oldest message age for every watched queue (Redis lists, streams,
 *       sets and pub/sub channels, plus the Celery queues on the RabbitMQ
 *       broker), together with the configured backpressure thresholds.
 *     responses:
 *       '200':
 *         description: Queue depths returned
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
 *                     thresholds:
 *                       type: object
 *                     queues:
 *                       type: array
 *                       items:
 *                         type: object
 *                         properties:
 *                           name:
 *                             type: string
 *                           pool:
 *                             type: string
 *                           transport:
 *                             type: string
 *                           pending:
 *                             type: integer
 *                           consumers:
 *                             type: integer
 *                             nullable: true
 *                     totals:
 *                       type: object
 *       '500':
 *         description: Internal server error
 */
router.get("/queues", handlers.queues);

/**
 * @swagger
 * /api/v1/admin/event-bus/history:
 *   get:
 *     tags:
 *       - Admin
 *     summary: Recent event bus backlog trend
 *     parameters:
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *           default: 60
 *           maximum: 720
 *         description: Number of retained cycles to return.
 *     responses:
 *       '200':
 *         description: Backlog history returned
 */
router.get("/history", handlers.history);

/**
 * @swagger
 * /api/v1/admin/event-bus/alerts:
 *   get:
 *     tags:
 *       - Admin
 *     summary: Queue backpressure alert bot status
 *     description: >
 *       Reports the current backpressure level for every scope (each queue plus
 *       the event-bus aggregate), the incident bookkeeping (peak backlog, last
 *       notification) and whether Slack / PagerDuty delivery is configured.
 *     responses:
 *       '200':
 *         description: Alert bot status returned
 */
router.get("/alerts", handlers.alerts);

/**
 * @swagger
 * /api/v1/admin/event-bus/autoscaler:
 *   get:
 *     tags:
 *       - Admin
 *     summary: Worker autoscaler status
 *     description: >
 *       Reports the autoscaler configuration plus the replica decisions taken
 *       for each worker pool on the last cycle, including any guard rail that
 *       blocked a scale action (cooldown, stabilization window, min/max).
 *     responses:
 *       '200':
 *         description: Autoscaler status returned
 */
router.get("/autoscaler", handlers.autoscaler);

/**
 * @swagger
 * /api/v1/admin/event-bus/collect:
 *   post:
 *     tags:
 *       - Admin
 *     summary: Force an out-of-band queue depth collection
 *     description: >
 *       Runs a single monitoring cycle immediately instead of waiting for the
 *       next tick. Useful during an incident to confirm a backlog is draining.
 *     responses:
 *       '200':
 *         description: Cycle completed
 *       '500':
 *         description: Collection failed
 */
router.post("/collect", requireAdmin, handlers.collect);

export default router;
