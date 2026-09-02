import { Router, Request, Response } from "express";
import prisma from "../lib/prisma";
import { addValidatorSignature } from "../services/bridgeSignatureVerification";
import { getBridgeQueueService } from "../services/bridgeQueueService";
import { simulateMintTransaction } from "../services/bridgeMintingService";
import { logger } from "../utils/logger";

const router = Router();

/**
 * @swagger
 * /api/v1/bridge/chains:
 *   get:
 *     tags:
 *       - Bridge
 *     summary: Get all bridge chains
 *     description: Retrieve all configured bridge chains with their validators
 *     responses:
 *       '200':
 *         description: List of bridge chains
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 chains:
 *                   type: array
 *                   items:
 *                     type: object
 */
router.get("/chains", async (req: Request, res: Response) => {
  try {
    const chains = await prisma.bridgeChain.findMany({
      include: { bridgeValidators: true },
      orderBy: { chainName: "asc" },
    });

    res.json({
      success: true,
      chains,
    });
  } catch (error) {
    logger.error("[BridgeRoutes] Failed to fetch chains:", error);
    res.status(500).json({
      success: false,
      error: "Failed to fetch bridge chains",
    });
  }
});

/**
 * @swagger
 * /api/v1/bridge/chains:
 *   post:
 *     tags:
 *       - Bridge
 *     summary: Create a new bridge chain
 *     description: Add a new blockchain to the bridge configuration
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               chainId:
 *                 type: string
 *               chainName:
 *                 type: string
 *               chainType:
 *                 type: string
 *                 enum: [EVM, Stellar]
 *               rpcUrl:
 *                 type: string
 *               explorerUrl:
 *                 type: string
 *               bridgeContract:
 *                 type: string
 *     responses:
 *       '201':
 *         description: Chain created successfully
 */
router.post("/chains", async (req: Request, res: Response) => {
  try {
    const { chainId, chainName, chainType, rpcUrl, explorerUrl, bridgeContract } = req.body;

    const chain = await prisma.bridgeChain.create({
      data: {
        chainId,
        chainName,
        chainType,
        rpcUrl,
        explorerUrl,
        bridgeContract,
        isActive: true,
      },
    });

    res.status(201).json({
      success: true,
      chain,
    });
  } catch (error) {
    logger.error("[BridgeRoutes] Failed to create chain:", error);
    res.status(500).json({
      success: false,
      error: "Failed to create bridge chain",
    });
  }
});

/**
 * @swagger
 * /api/v1/bridge/validators:
 *   get:
 *     tags:
 *       - Bridge
 *     summary: Get all validators
 *     description: Retrieve all bridge validators
 *     responses:
 *       '200':
 *         description: List of validators
 */
router.get("/validators", async (req: Request, res: Response) => {
  try {
    const validators = await prisma.bridgeValidator.findMany({
      include: { chain: true },
      orderBy: { chainId: "asc" },
    });

    res.json({
      success: true,
      validators,
    });
  } catch (error) {
    logger.error("[BridgeRoutes] Failed to fetch validators:", error);
    res.status(500).json({
      success: false,
      error: "Failed to fetch validators",
    });
  }
});

/**
 * @swagger
 * /api/v1/bridge/validators:
 *   post:
 *     tags:
 *       - Bridge
 *     summary: Add a new validator
 *     description: Add a validator to a bridge chain
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               chainId:
 *                 type: string
 *               validatorAddress:
 *                 type: string
 *               validatorName:
 *                 type: string
 *               weight:
 *                 type: integer
 *     responses:
 *       '201':
 *         description: Validator created successfully
 */
router.post("/validators", async (req: Request, res: Response) => {
  try {
    const { chainId, validatorAddress, validatorName, weight } = req.body;

    // Find the chain by chainId string
    const chain = await prisma.bridgeChain.findUnique({
      where: { chainId },
    });

    if (!chain) {
      return res.status(404).json({
        success: false,
        error: "Chain not found",
      });
    }

    const validator = await prisma.bridgeValidator.create({
      data: {
        chainId: chain.id,
        validatorAddress,
        validatorName,
        weight: weight || 1,
        isActive: true,
      },
    });

    res.status(201).json({
      success: true,
      validator,
    });
  } catch (error) {
    logger.error("[BridgeRoutes] Failed to create validator:", error);
    res.status(500).json({
      success: false,
      error: "Failed to create validator",
    });
  }
});

/**
 * @swagger
 * /api/v1/bridge/events:
 *   get:
 *     tags:
 *       - Bridge
 *     summary: Get bridge events
 *     description: Retrieve bridge events with optional filtering
 *     parameters:
 *       - in: query
 *         name: status
 *         schema:
 *           type: string
 *       - in: query
 *         name: chainId
 *         schema:
 *           type: integer
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *     responses:
 *       '200':
 *         description: List of bridge events
 */
router.get("/events", async (req: Request, res: Response) => {
  try {
    const { status, chainId, limit } = req.query;

    const events = await prisma.bridgeEvent.findMany({
      where: {
        ...(status && { status: status as string }),
        ...(chainId && { chainId: parseInt(chainId as string) }),
      },
      include: {
        chain: true,
        validatorSignatures: {
          include: { validator: true },
        },
      },
      orderBy: { eventTimestamp: "desc" },
      take: limit ? parseInt(limit as string) : 50,
    });

    res.json({
      success: true,
      events,
    });
  } catch (error) {
    logger.error("[BridgeRoutes] Failed to fetch events:", error);
    res.status(500).json({
      success: false,
      error: "Failed to fetch bridge events",
    });
  }
});

/**
 * @swagger
 * /api/v1/bridge/events/{id}/sign:
 *   post:
 *     tags:
 *       - Bridge
 *     summary: Add validator signature to event
 *     description: Submit a validator signature for a bridge event
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: integer
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               validatorAddress:
 *                 type: string
 *               signature:
 *                 type: string
 *     responses:
 *       '200':
 *         description: Signature added successfully
 */
router.post("/events/:id/sign", async (req: Request, res: Response) => {
  try {
    const eventId = parseInt(req.params.id);
    const { validatorAddress, signature } = req.body;

    const result = await addValidatorSignature(eventId, validatorAddress, signature);

    res.json({
      success: true,
      ...result,
    });
  } catch (error) {
    logger.error("[BridgeRoutes] Failed to add signature:", error);
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : "Failed to add signature",
    });
  }
});

/**
 * @swagger
 * /api/v1/bridge/operations:
 *   get:
 *     tags:
 *       - Bridge
 *     summary: Get bridge operations (queue)
 *     description: Retrieve bridge operations from the processing queue
 *     parameters:
 *       - in: query
 *         name: status
 *         schema:
 *           type: string
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *     responses:
 *       '200':
 *         description: List of bridge operations
 */
router.get("/operations", async (req: Request, res: Response) => {
  try {
    const { status, limit } = req.query;

    const operations = await prisma.bridgeOperation.findMany({
      where: {
        ...(status && { queueStatus: status as string }),
      },
      include: {
        bridgeEvent: {
          include: { chain: true },
        },
      },
      orderBy: [
        { priority: "asc" },
        { queuedAt: "asc" },
      ],
      take: limit ? parseInt(limit as string) : 50,
    });

    res.json({
      success: true,
      operations,
    });
  } catch (error) {
    logger.error("[BridgeRoutes] Failed to fetch operations:", error);
    res.status(500).json({
      success: false,
      error: "Failed to fetch bridge operations",
    });
  }
});

/**
 * @swagger
 * /api/v1/bridge/queue/stats:
 *   get:
 *     tags:
 *       - Bridge
 *     summary: Get queue statistics
 *     description: Retrieve statistics about the bridge operation queue
 *     responses:
 *       '200':
 *         description: Queue statistics
 */
router.get("/queue/stats", async (req: Request, res: Response) => {
  try {
    const queueService = getBridgeQueueService();
    const stats = await queueService.getStats();

    res.json({
      success: true,
      stats,
    });
  } catch (error) {
    logger.error("[BridgeRoutes] Failed to fetch queue stats:", error);
    res.status(500).json({
      success: false,
      error: "Failed to fetch queue statistics",
    });
  }
});

/**
 * @swagger
 * /api/v1/bridge/queue/retry:
 *   post:
 *     tags:
 *       - Bridge
 *     summary: Retry failed operations
 *     description: Requeue failed bridge operations that haven't exceeded max retries
 *     responses:
 *       '200':
 *         description: Operations requeued
 */
router.post("/queue/retry", async (req: Request, res: Response) => {
  try {
    const queueService = getBridgeQueueService();
    const count = await queueService.retryFailedOperations();

    res.json({
      success: true,
      requeued: count,
    });
  } catch (error) {
    logger.error("[BridgeRoutes] Failed to retry operations:", error);
    res.status(500).json({
      success: false,
      error: "Failed to retry operations",
    });
  }
});

/**
 * @swagger
 * /api/v1/bridge/simulate:
 *   post:
 *     tags:
 *       - Bridge
 *     summary: Simulate mint transaction
 *     description: Simulate a Soroban mint transaction without submitting it
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               sorobanContract:
 *                 type: string
 *               mintAmount:
 *                 type: string
 *               recipientAddress:
 *                 type: string
 *     responses:
 *       '200':
 *         description: Simulation result
 */
router.post("/simulate", async (req: Request, res: Response) => {
  try {
    const { sorobanContract, mintAmount, recipientAddress } = req.body;

    const result = await simulateMintTransaction({
      bridgeEventId: 0, // Simulation doesn't require a real event
      sorobanContract,
      mintAmount,
      recipientAddress,
    });

    res.json({
      success: true,
      ...result,
    });
  } catch (error) {
    logger.error("[BridgeRoutes] Failed to simulate transaction:", error);
    res.status(500).json({
      success: false,
      error: "Failed to simulate transaction",
    });
  }
});

export default router;
