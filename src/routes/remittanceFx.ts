import { Router } from "express";
import { calculateFxQuote } from "../controllers/remittanceFxController";

const router = Router();

/**
 * @swagger
 * /api/v1/remittance/fx/quote:
 *   post:
 *     tags:
 *       - Remittance FX
 *     summary: Compute real-time cross-border FX quote with dynamic fees
 *     description: Computes corridor conversion rate (e.g. USD/NGN, EUR/KES) with dynamic fee margins and 60s Redis caching.
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - sourceCurrency
 *               - targetCurrency
 *               - sourceAmount
 *             properties:
 *               sourceCurrency:
 *                 type: string
 *                 example: USD
 *               targetCurrency:
 *                 type: string
 *                 example: NGN
 *               sourceAmount:
 *                 type: number
 *                 example: 1000
 *               routeLiquidityScore:
 *                 type: number
 *                 example: 0.85
 *     responses:
 *       '200':
 *         description: FX quote calculated successfully
 *       '400':
 *         description: Invalid parameters
 *       '500':
 *         description: Internal server error
 */
router.post("/quote", calculateFxQuote);
router.get("/quote", calculateFxQuote);

export default router;
