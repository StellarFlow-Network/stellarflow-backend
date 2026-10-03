import { Router, Request, Response } from "express";
import { zkCdnManager } from "../services/zkCdnManager";
import { sendApiError } from "../lib/apiError";
import { requireAdmin } from "../middleware/roleMatrixMiddleware";
import { logger } from "../utils/logger";

const router = Router();

/**
 * @swagger
 * /api/v1/zk/params/{circuit_id}:
 *   get:
 *     summary: Get optimal CDN download URLs for ZK proving and verifying keys
 *     parameters:
 *       - in: path
 *         name: circuit_id
 *         required: true
 *         schema: { type: string }
 *       - in: query
 *         name: version
 *         schema: { type: string }
 *         description: Smart contract release tag version (optional)
 *     responses:
 *       200:
 *         description: Optimal CDN URLs and key parameters
 */
router.get("/:circuit_id", async (req: Request, res: Response) => {
  try {
    const circuitId = req.params.circuit_id;
    const version = typeof req.query.version === "string" ? req.query.version : undefined;

    if (!circuitId) {
      sendApiError(res, 400, "BAD_REQUEST", "circuit_id is required");
      return;
    }

    const metadata = zkCdnManager.getOptimalParamUrls(circuitId, version);
    res.json({
      success: true,
      data: metadata,
    });
  } catch (error) {
    logger.error("[ZkParamsRouter] Failed to fetch ZK param URLs:", error);
    sendApiError(res, 500, "INTERNAL_SERVER_ERROR", error instanceof Error ? error.message : "Failed to retrieve ZK parameters");
  }
});

/**
 * ADMIN Route: Upload compiled .zkey and optional vkey to CDN distribution points
 */
router.post("/:circuit_id/upload", requireAdmin, async (req: Request, res: Response) => {
  try {
    const circuitId = req.params.circuit_id;
    const version = typeof req.body.version === "string" ? req.body.version : process.env.STABLE_SMART_CONTRACT_VERSION || "v1.0.0";

    const zkeyPath = req.body.zkey_path || req.body.zkeyPath;
    if (!zkeyPath) {
      sendApiError(res, 400, "BAD_REQUEST", "zkey_path is required");
      return;
    }

    const vkeyPath = req.body.vkey_path || req.body.vkeyPath;

    const metadata = await zkCdnManager.uploadCircuitKeys(circuitId, version, zkeyPath, vkeyPath);

    res.status(201).json({
      success: true,
      message: "ZK proving keys successfully distributed to CDN",
      data: metadata,
    });
  } catch (error) {
    logger.error("[ZkParamsRouter] Failed to upload ZK parameters:", error);
    sendApiError(res, 500, "INTERNAL_SERVER_ERROR", error instanceof Error ? error.message : "Failed to upload ZK parameters");
  }
});

export default router;
