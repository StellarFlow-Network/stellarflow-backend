import { Router } from "express";
import {
  getReadinessReport,
  READINESS_UNAVAILABLE_STATUS,
  type ReadinessReport,
} from "../services/healthProbeService";

export function createHealthRouter(
  loadReadiness: () => Promise<ReadinessReport> = getReadinessReport,
) {
  const router = Router();

  router.get("/liveness", (_req, res) => {
    res.status(200).json({
      success: true,
      status: "ok",
      timestamp: new Date().toISOString(),
    });
  });

  router.get("/readiness", async (_req, res) => {
    const report = await loadReadiness();

    if (!report.ready) {
      res.status(READINESS_UNAVAILABLE_STATUS).json({
        success: false,
        status: "unavailable",
        timestamp: report.timestamp,
        checks: report.checks,
        errors: report.errors,
        error: {
          code: "DEPENDENCY_UNAVAILABLE",
          message: "One or more core dependencies failed readiness probes",
          timestamp: report.timestamp,
        },
      });
      return;
    }

    res.status(200).json({
      success: true,
      status: "ready",
      timestamp: report.timestamp,
      checks: report.checks,
    });
  });

  return router;
}

export default createHealthRouter();
