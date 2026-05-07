/**
 * Issuer Onboarding Routes — Issue #120
 *
 * POST /api/v1/issuer/apply          — Healthcare provider submits application
 * GET  /api/v1/issuer/applications   — Admin: list all applications
 * GET  /api/v1/issuer/pending        — Admin: list pending applications
 * POST /api/v1/issuer/:id/decision   — Admin: approve or reject
 */

import express, { Request, Response } from "express";
import {
  submitIssuerApplication,
  listPendingApplications,
  listAllApplications,
  processAdminDecision,
} from "../services/issuerOnboardingService.js";

const router = express.Router();

// Healthcare provider submits an onboarding request
router.post("/apply", async (req: Request, res: Response): Promise<void> => {
  try {
    const { name, licenseNumber, country, walletAddress } = req.body as {
      name?: string;
      licenseNumber?: string;
      country?: string;
      walletAddress?: string;
    };

    if (!name || !licenseNumber || !country || !walletAddress) {
      res.status(400).json({
        success: false,
        error: {
          code: "MISSING_FIELDS",
          message: "name, licenseNumber, country, and walletAddress are required.",
        },
      });
      return;
    }

    const request = await submitIssuerApplication({ name, licenseNumber, country, walletAddress });

    res.status(201).json({
      success: true,
      data: request,
      message: "Your application has been submitted and is pending admin review.",
    });
  } catch (err: any) {
    const isDuplicate = err?.message?.includes("already exists");
    res.status(isDuplicate ? 409 : 500).json({
      success: false,
      error: { code: isDuplicate ? "DUPLICATE_APPLICATION" : "INTERNAL_ERROR", message: err.message },
    });
  }
});

// Admin: list all applications
router.get("/applications", async (_req: Request, res: Response): Promise<void> => {
  try {
    const applications = await listAllApplications();
    res.json({ success: true, data: applications });
  } catch (err: any) {
    res.status(500).json({ success: false, error: { code: "INTERNAL_ERROR", message: err.message } });
  }
});

// Admin: list pending applications
router.get("/pending", async (_req: Request, res: Response): Promise<void> => {
  try {
    const pending = await listPendingApplications();
    res.json({ success: true, data: pending });
  } catch (err: any) {
    res.status(500).json({ success: false, error: { code: "INTERNAL_ERROR", message: err.message } });
  }
});

// Admin: approve or reject an application
router.post("/:id/decision", async (req: Request, res: Response): Promise<void> => {
  try {
    const requestId = parseInt(req.params.id, 10);
    const { approve, reviewedBy, reviewNote } = req.body as {
      approve?: boolean;
      reviewedBy?: string;
      reviewNote?: string;
    };

    if (typeof approve !== "boolean" || !reviewedBy) {
      res.status(400).json({
        success: false,
        error: { code: "MISSING_FIELDS", message: "approve (boolean) and reviewedBy are required." },
      });
      return;
    }

    const updated = await processAdminDecision({ requestId, approve, reviewedBy, reviewNote });

    res.json({
      success: true,
      data: updated,
      message: `Application ${approve ? "approved" : "rejected"} successfully.`,
    });
  } catch (err: any) {
    const isNotFound = err?.message?.includes("not found");
    const isAlreadyProcessed = err?.message?.includes("already been");
    const status = isNotFound ? 404 : isAlreadyProcessed ? 409 : 500;
    res.status(status).json({
      success: false,
      error: { code: "DECISION_ERROR", message: err.message },
    });
  }
});

export default router;
