import { Request, Response } from "express";
import { sendApiError } from "../lib/apiError.js";
import { YieldEmissionService } from "../services/yieldEmissionService";

const yieldEmissionService = new YieldEmissionService();

export const getEmissions = async (req: Request, res: Response) => {
  try {
    const result = await yieldEmissionService.getEmissions();

    if (result.success) {
      res.json({
        success: true,
        data: result.data,
      });
    } else {
      sendApiError(res, 500, "INTERNAL_SERVER_ERROR", result.error);
    }
  } catch (error) {
    sendApiError(
      res,
      500,
      "INTERNAL_SERVER_ERROR",
      error instanceof Error ? error.message : "Failed to fetch emissions data"
    );
  }
};

export const getCurrentEmissionRate = async (req: Request, res: Response) => {
  try {
    const result = await yieldEmissionService.getCurrentEmissionRate();

    if (result.success) {
      res.json({
        success: true,
        data: {
          currentEmissionRate: result.data,
        },
      });
    } else {
      sendApiError(res, 500, "INTERNAL_SERVER_ERROR", result.error);
    }
  } catch (error) {
    sendApiError(
      res,
      500,
      "INTERNAL_SERVER_ERROR",
      error instanceof Error ? error.message : "Failed to fetch current emission rate"
    );
  }
};

export const getEmissionSchedule = async (req: Request, res: Response) => {
  try {
    const result = await yieldEmissionService.getEmissionSchedule();

    if (result.success) {
      res.json({
        success: true,
        data: result.data,
      });
    } else {
      sendApiError(res, 500, "INTERNAL_SERVER_ERROR", result.error);
    }
  } catch (error) {
    sendApiError(
      res,
      500,
      "INTERNAL_SERVER_ERROR",
      error instanceof Error ? error.message : "Failed to fetch emission schedule"
    );
  }
};
