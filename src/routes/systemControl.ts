import { Router } from "express";
import { systemControlController } from "../controllers/systemControlController";

const router = Router();

/**
 * @swagger
 * /api/admin/system/halt:
 *   post:
 *     tags:
 *       - System Control
 *     summary: Initiate system halt requiring consensus approval
 *     description: >
 *       Creates a system halt request that requires approval from multiple administrators
 *       before execution. The halt will stop the system from accepting new requests.
 *     requestBody:
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - reason
 *             properties:
 *               reason:
 *                 type: string
 *                 description: Reason for the system halt
 *                 example: "Emergency maintenance required"
 *               duration:
 *                 type: number
 *                 description: Duration in hours for the halt
 *                 default: 24
 *               emergencyLevel:
 *                 type: string
 *                 enum: [LOW, MEDIUM, HIGH, CRITICAL]
 *                 description: Emergency level affects required signatures
 *                 default: MEDIUM
 *     responses:
 *       '201':
 *         description: Halt request created successfully
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
 *                     consensusId:
 *                       type: integer
 *                     status:
 *                       type: string
 *                     requiredSignatures:
 *                       type: integer
 *                     expiresAt:
 *                       type: string
 *                       format: date-time
 *       '400':
 *         description: Invalid input data
 *       '500':
 *         description: Server error
 */
router.post("/halt", systemControlController.initiateHaltRequest.bind(systemControlController));

/**
 * @swagger
 * /api/admin/system/upgrade:
 *   post:
 *     tags:
 *       - System Control
 *     summary: Initiate system upgrade requiring consensus approval
 *     description: >
 *       Creates a system upgrade request that requires approval from multiple administrators
 *       before execution. Supports patch, minor, and major upgrades.
 *     requestBody:
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - version
 *               - upgradeType
 *             properties:
 *               version:
 *                 type: string
 *                 description: Target version for upgrade
 *                 example: "2.1.0"
 *               upgradeType:
 *                 type: string
 *                 enum: [PATCH, MINOR, MAJOR]
 *                 description: Type of upgrade affects required signatures
 *               scheduledAt:
 *                 type: string
 *                 format: date-time
 *                 description: When to schedule the upgrade (default: 1 hour from now)
 *               rollbackPlan:
 *                 type: string
 *                 description: Plan for rolling back if upgrade fails
 *               notes:
 *                 type: string
 *                 description: Additional notes about the upgrade
 *     responses:
 *       '201':
 *         description: Upgrade request created successfully
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
 *                     consensusId:
 *                       type: integer
 *                     status:
 *                       type: string
 *                     requiredSignatures:
 *                       type: integer
 *                     expiresAt:
 *                       type: string
 *                       format: date-time
 *       '400':
 *         description: Invalid input data
 *       '500':
 *         description: Server error
 */
router.post("/upgrade", systemControlController.initiateUpgradeRequest.bind(systemControlController));

/**
 * @swagger
 * /api/admin/system/consensus/{consensusId}/signature:
 *   post:
 *     tags:
 *       - System Control
 *     summary: Add admin signature to consensus request
 *     description: >
 *       Adds an administrator's signature to a pending consensus request.
 *       Once the required number of signatures is collected, the action can be executed.
 *     parameters:
 *       - in: path
 *         name: consensusId
 *         required: true
 *         schema:
 *           type: integer
 *         description: ID of the consensus request
 *       - in: header
 *         name: Authorization
 *         required: true
 *         schema:
 *           type: string
 *         description: Admin authentication token
 *     requestBody:
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - signature
 *             properties:
 *               signature:
 *                 type: string
 *                 description: Cryptographic signature from the admin
 *                 example: "abcd1234567890..."
 *     responses:
 *       '200':
 *         description: Signature added successfully
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
 *                     consensusId:
 *                       type: integer
 *                     canExecute:
 *                       type: boolean
 *                     pendingSignatures:
 *                       type: array
 *                       items:
 *                         type: object
 *                     missingSignatures:
 *                       type: integer
 *       '400':
 *         description: Invalid consensus ID or signature
 *       '404':
 *         description: Consensus request not found
 *       '500':
 *         description: Server error
 */
router.post("/consensus/:consensusId/signature", systemControlController.addSignature.bind(systemControlController));

/**
 * @swagger
 * /api/admin/system/consensus/{consensusId}/execute:
 *   post:
 *     tags:
 *       - System Control
 *     summary: Execute approved consensus request
 *     description: >
 *       Executes a consensus request that has received the required number of signatures.
 *       This will perform the actual system action (halt or upgrade).
 *     parameters:
 *       - in: path
 *         name: consensusId
 *         required: true
 *         schema:
 *           type: integer
 *         description: ID of the approved consensus request
 *       - in: header
 *         name: Authorization
 *         required: true
 *         schema:
 *           type: string
 *         description: Admin authentication token
 *     responses:
 *       '200':
 *         description: Action executed successfully
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
 *                     consensusId:
 *                       type: integer
 *                     actionType:
 *                       type: string
 *                     executedAt:
 *                       type: string
 *                       format: date-time
 *                     result:
 *                       type: string
 *       '400':
 *         description: Consensus not ready for execution
 *       '404':
 *         description: Consensus request not found
 *       '500':
 *         description: Execution failed or server error
 */
router.post("/consensus/:consensusId/execute", systemControlController.executeConsensus.bind(systemControlController));

/**
 * @swagger
 * /api/admin/system/consensus/pending:
 *   get:
 *     tags:
 *       - System Control
 *     summary: Get all pending consensus requests
 *     description: >
 *       Returns a list of all consensus requests that are currently pending approval.
 *       Useful for administrators to see what actions need their approval.
 *     parameters:
 *       - in: header
 *         name: Authorization
 *         required: true
 *         schema:
 *           type: string
 *         description: Admin authentication token
 *     responses:
 *       '200':
 *         description: Pending requests retrieved successfully
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
 *                     pendingRequests:
 *                       type: array
 *                       items:
 *                         type: object
 *                         properties:
 *                           id:
 *                             type: integer
 *                           actionType:
 *                             type: string
 *                           actionData:
 *                             type: string
 *                           status:
 *                             type: string
 *                           requiredSignatures:
 *                             type: integer
 *                           collectedSignatures:
 *                             type: integer
 *                           requestedBy:
 *                             type: string
 *                           requestedAt:
 *                             type: string
 *                             format: date-time
 *                           expiresAt:
 *                             type: string
 *                             format: date-time
 *                           pendingSignatures:
 *                             type: array
 *                             items:
 *                               type: object
 *                     count:
 *                       type: integer
 *       '500':
 *         description: Server error
 */
router.get("/consensus/pending", systemControlController.getPendingRequests.bind(systemControlController));

/**
 * @swagger
 * /api/admin/system/consensus/{consensusId}:
 *   get:
 *     tags:
 *       - System Control
 *     summary: Get consensus request details
 *     description: >
 *       Returns detailed information about a specific consensus request,
 *       including all signatures and current status.
 *     parameters:
 *       - in: path
 *         name: consensusId
 *         required: true
 *         schema:
 *           type: integer
 *         description: ID of the consensus request
 *       - in: header
 *         name: Authorization
 *         required: true
 *         schema:
 *           type: string
 *         description: Admin authentication token
 *     responses:
 *       '200':
 *         description: Consensus details retrieved successfully
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
 *                     id:
 *                       type: integer
 *                     actionType:
 *                       type: string
 *                     actionData:
 *                       type: string
 *                     status:
 *                       type: string
 *                     requiredSignatures:
 *                       type: integer
 *                     collectedSignatures:
 *                       type: integer
 *                     requestedBy:
 *                       type: string
 *                     requestedAt:
 *                       type: string
 *                       format: date-time
 *                     expiresAt:
 *                       type: string
 *                       format: date-time
 *                     executedAt:
 *                       type: string
 *                       format: date-time
 *                     executionResult:
 *                       type: string
 *                     pendingSignatures:
 *                       type: array
 *                       items:
 *                         type: object
 *       '400':
 *         description: Invalid consensus ID
 *       '404':
 *         description: Consensus request not found
 *       '500':
 *         description: Server error
 */
router.get("/consensus/:consensusId", systemControlController.getConsensusDetails.bind(systemControlController));

export default router;
