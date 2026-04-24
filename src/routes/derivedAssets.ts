import { Router } from "express";
import {
  getDerivedRate,
  getNGNGHSRate,
} from "../controllers/derivedAssetController";

const router = Router();

/**
 * @swagger
 * /api/v1/derived-assets/rate/{base}/{quote}:
 *   get:
 *     tags:
 *       - Derived Assets
 *     summary: Get synthetic cross-rate between two currencies
 *     description: Calculates a synthetic exchange rate derived from XLM-based oracle rates
 *     parameters:
 *       - in: path
 *         name: base
 *         required: true
 *         schema:
 *           type: string
 *         description: Base currency code (e.g., NGN)
 *       - in: path
 *         name: quote
 *         required: true
 *         schema:
 *           type: string
 *         description: Quote currency code (e.g., GHS)
 *     responses:
 *       '200':
 *         description: Successfully calculated derived rate
 *       '500':
 *         description: Internal server error
 */
router.get("/rate/:base/:quote", getDerivedRate);

/**
 * @swagger
 * /api/v1/derived-assets/ngn-ghs:
 *   get:
 *     tags:
 *       - Derived Assets
 *     summary: Get synthetic NGN/GHS cross-rate
 *     description: Specifically returns the NGN per 1 GHS synthetic rate
 *     responses:
 *       '200':
 *         description: Successfully calculated NGN/GHS rate
 *       '500':
 *         description: Internal server error
 */
router.get("/ngn-ghs", getNGNGHSRate);

export default router;
