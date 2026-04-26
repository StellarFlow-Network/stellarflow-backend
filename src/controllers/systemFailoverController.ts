import { Request, Response } from "express";
import { getRegionalHealthService } from "../services/regionalHealthService";

type FailoverRegion = "PRIMARY" | "SECONDARY";

export class SystemFailoverController {
  async performFailover(req: Request, res: Response): Promise<void> {
    try {
      const { targetRegion } = req.body as { targetRegion?: FailoverRegion };

      if (!targetRegion || (targetRegion !== "PRIMARY" && targetRegion !== "SECONDARY")) {
        res.status(400).json({
          success: false,
          error: "Invalid or missing targetRegion. Expected 'PRIMARY' or 'SECONDARY'.",
        });
        return;
      }

      const service = getRegionalHealthService();
      const state = await service.forceFailover(targetRegion);

      res.status(200).json({
        success: true,
        message: `Manual failover applied. Active region is now ${state.activeRegion}.`,
        data: state,
      });
    } catch (error) {
      console.error("[SystemFailoverController] performFailover failed:", error);
      res.status(500).json({
        success: false,
        error: "Could not perform manual failover",
      });
    }
  }

  async resetFailover(req: Request, res: Response): Promise<void> {
    try {
      const service = getRegionalHealthService();
      const state = await service.resetManualOverride();

      res.status(200).json({
        success: true,
        message: "Manual override reset. Automatic regional health monitoring is now active.",
        data: state,
      });
    } catch (error) {
      console.error("[SystemFailoverController] resetFailover failed:", error);
      res.status(500).json({
        success: false,
        error: "Could not reset failover override",
      });
    }
  }

  async getFailoverStatus(req: Request, res: Response): Promise<void> {
    try {
      const service = getRegionalHealthService();
      const state = service.getState();

      res.status(200).json({
        success: true,
        data: state,
      });
    } catch (error) {
      console.error("[SystemFailoverController] getFailoverStatus failed:", error);
      res.status(500).json({
        success: false,
        error: "Could not retrieve failover status",
      });
    }
  }
}

export const systemFailoverController = new SystemFailoverController();
