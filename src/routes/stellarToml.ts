import { Router, Request, Response } from "express";
import { sendApiError } from "../lib/apiError.js";
import { sep01TomlService } from "../services/sep01TomlService";

const router = Router();

/**
 * GET /.well-known/stellar.toml
 *
 * Serves the dynamically generated SEP-01 metadata file. The response is
 * cached in Redis for one hour by the generator service.
 *
 * @swagger
 * /.well-known/stellar.toml:
 *   get:
 *     tags: [SEP-01]
 *     summary: SEP-01 stellar.toml metadata
 *     responses:
 *       200:
 *         description: SEP-01 TOML document.
 *         content:
 *           text/plain:
 *             schema:
 *               type: string
 */
router.get("/stellar.toml", async (_req: Request, res: Response) => {
  try {
    const { toml, expiresInSeconds } = await sep01TomlService.getToml();
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.setHeader("Cache-Control", `public, max-age=${expiresInSeconds}`);
    res.status(200).send(toml);
  } catch (error) {
    sendApiError(
      res,
      500,
      "INTERNAL_SERVER_ERROR",
      error instanceof Error ? error.message : "Failed to generate stellar.toml",
    );
  }
});

export default router;
