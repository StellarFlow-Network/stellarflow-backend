import { sendApiError } from "../lib/apiError.js";
import { MarketRateService } from "../services/marketRate";
const marketRateService = new MarketRateService();
export const getRate = async (req, res) => {
    try {
        const { currency } = req.params;
        if (!currency || typeof currency !== "string") {
            return sendApiError(res, 400, "BAD_REQUEST", "Currency parameter is required and must be a string");
        }
        const result = await marketRateService.getRate(currency);
        if (result.success) {
            res.json({
                success: true,
                data: result.data,
            });
        }
        else {
            sendApiError(res, 404, "NOT_FOUND", typeof (result.error) === "string" ? String(result.error) : undefined);
        }
    }
    catch (error) {
        sendApiError(res, 500, "INTERNAL_SERVER_ERROR", typeof (error instanceof Error ? error.message : "Internal server error") === "string" ? String(error instanceof Error ? error.message : "Internal server error") : undefined);
    }
};
export const getAllRates = async (req, res) => {
    try {
        const results = await marketRateService.getAllRates();
        const rates = results
            .filter((result) => result.success)
            .map((result) => result.data);
        res.json({
            success: true,
            data: rates,
        });
    }
    catch (error) {
        sendApiError(res, 500, "INTERNAL_SERVER_ERROR", typeof (error instanceof Error ? error.message : "Internal server error") === "string" ? String(error instanceof Error ? error.message : "Internal server error") : undefined);
    }
};
//# sourceMappingURL=marketRatesController.js.map