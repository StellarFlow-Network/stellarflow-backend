import { Router, Request, Response } from "express";
import { sendApiError } from "../lib/apiError.js";
import { sorobanStateRootInspectorWorker } from "../services/sorobanStateRootInspectorWorker";

const router = Router();

/**
 * GET /api/v1/security/state-root
 *
 * Returns the most recent off-chain vs on-chain state root inspection. A
 * `matched: false` response with reason `ROOT_MISMATCH` indicates the worker
 * raised a critical security alert.
 *
 * @swagger
 * /api/v1/security/state-root:
 *   get:
 *     tags: [Security]
 *     summary: Latest Soroban state root inspection
 *     responses:
 *       200:
 *         description: State root inspection snapshot.
 */
router.get("/state-root", async (_req: Request, res: Response) => {
  try {
    const inspection = sorobanStateRootInspectorWorker.getLastInspection();
    if (!inspection) {
      res.status(503).json({
        success: false,
        message: "State root inspection has not run yet",
      });
      return;
    }

    res.json({
      success: true,
      data: {
        ...inspection,
        running: sorobanStateRootInspectorWorker.isRunning(),
        lastHeartbeatAt: sorobanStateRootInspectorWorker.getLastHeartbeatAt(),
      },
    });
  } catch (error) {
    sendApiError(
      res,
      500,
      "INTERNAL_SERVER_ERROR",
      error instanceof Error ? error.message : "Failed to read state root status",
    );
  }
});

export default router;
