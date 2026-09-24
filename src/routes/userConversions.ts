import { Router } from "express";
import { sendApiError } from "../lib/apiError.js";
import { UserConversionHistoryService } from "../services/userConversionHistoryService";

const router = Router();
const historyService = new UserConversionHistoryService();

router.get("/:address/conversions", async (req, res) => {
  try {
    const address = req.params.address?.trim();
    if (!address) {
      sendApiError(res, 400, "BAD_REQUEST", "address is required");
      return;
    }

    const { currency, fromCurrency, toCurrency, cursor, limit } = req.query;
    const result = await historyService.getHistory({
      address,
      ...(typeof currency === "string" ? { currency } : {}),
      ...(typeof fromCurrency === "string" ? { fromCurrency } : {}),
      ...(typeof toCurrency === "string" ? { toCurrency } : {}),
      ...(typeof cursor === "string" ? { cursor } : {}),
      ...(typeof limit === "string" ? { limit: Number(limit) } : {}),
    });

    res.json({ success: true, ...result });
  } catch (error) {
    const message =
      error instanceof Error
        ? error.message
        : "Failed to fetch conversion history";
    const isBadRequest = message === "Invalid cursor";
    sendApiError(
      res,
      isBadRequest ? 400 : 500,
      isBadRequest ? "BAD_REQUEST" : "INTERNAL_SERVER_ERROR",
      message,
    );
  }
});

export default router;