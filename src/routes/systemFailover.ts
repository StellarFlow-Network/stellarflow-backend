import { Router } from "express";
import { systemFailoverController } from "../controllers/systemFailoverController";

const router = Router();

/**
 * @swagger
 * /api/v1/system/failover:
 *   post:
 *     tags:
 *       - System Control
 *     summary: Manually switch the active regional backend cluster
 *     description: Apply an administrative override to move traffic to either the Lagos primary cluster or the Frankfurt secondary cluster.
 *     requestBody:
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - targetRegion
 *             properties:
 *               targetRegion:
 *                 type: string
 *                 enum: [PRIMARY, SECONDARY]
 *                 description: Region to activate
 *                 example: PRIMARY
 *     responses:
 *       '200':
 *         description: Failover applied successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 message:
 *                   type: string
 *                 data:
 *                   type: object
 *                   properties:
 *                     activeRegion:
 *                       type: string
 *                     activeUrl:
 *                       type: string
 *       '400':
 *         description: Invalid request payload
 *       '403':
 *         description: Forbidden
 *       '500':
 *         description: Server error
 */
router.post(
  "/failover",
  systemFailoverController.performFailover.bind(systemFailoverController),
);

/**
 * @swagger
 * /api/v1/system/failover/reset:
 *   post:
 *     tags:
 *       - System Control
 *     summary: Reset the manual failover override
 *     description: Re-enable automatic regional failover logic after a manual override.
 *     responses:
 *       '200':
 *         description: Reset successful
 *       '500':
 *         description: Server error
 */
router.post(
  "/failover/reset",
  systemFailoverController.resetFailover.bind(systemFailoverController),
);

/**
 * @swagger
 * /api/v1/system/failover:
 *   get:
 *     tags:
 *       - System Control
 *     summary: Get current regional failover status
 *     description: Retrieve the current active cluster, health state of both regions, and whether a manual override is in effect.
 *     responses:
 *       '200':
 *         description: Status retrieved successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 data:
 *                   type: object
 */
router.get(
  "/failover",
  systemFailoverController.getFailoverStatus.bind(systemFailoverController),
);

export default router;
