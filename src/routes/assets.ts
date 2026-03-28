import { Router } from "express";
import prisma from "../lib/prisma";

const router = Router();

/**
 * @swagger
 * /api/v1/assets:
 *   get:
 *     tags:
 *       - Assets
 *     summary: Get a list of all active assets
 *     description: Returns a list of all active currency symbols (NGN, KES, GHS, etc.)
 *     responses:
 *       '200':
 *         description: Successfully retrieved active assets
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 assets:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       code:
 *                         type: string
 *                       name:
 *                         type: string
 *                       symbol:
 *                         type: string
 *       '500':
 *         description: Internal server error
 */
router.get("/", async (req, res) => {
  try {
    const assets = await prisma.currency.findMany({
      where: { isActive: true },
      select: {
        code: true,
        name: true,
        symbol: true,
      },
      orderBy: { code: "asc" },
    });

    res.json({
      success: true,
      assets,
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : "Internal server error",
    });
  }
});

export default router;
