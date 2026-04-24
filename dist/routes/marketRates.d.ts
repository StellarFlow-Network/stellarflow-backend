/**
 * @swagger
 * /api/v1/market-rates/rate/{currency}:
 *   get:
 *     tags:
 *       - Market Rates
 *     summary: Get exchange rate for a specific currency
 *     description: Fetch the current exchange rate for a specified currency
 *     parameters:
 *       - in: path
 *         name: currency
 *         required: true
 *         schema:
 *           type: string
 *         description: Currency code (e.g., GHS, NGN, KES)
 *         example: GHS
 *     responses:
 *       '200':
 *         description: Successfully retrieved exchange rate
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 data:
 *                   $ref: '#/components/schemas/MarketRate'
 *       '404':
 *         description: Currency not found
 *       '500':
 *         description: Internal server error
 */
declare const router: import("express-serve-static-core").Router;
export default router;
//# sourceMappingURL=marketRates.d.ts.map