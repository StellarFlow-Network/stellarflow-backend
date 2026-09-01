/**
 * DisputeController – Issue #834
 *
 * Admin-facing HTTP handlers for the remittance dispute-resolution flow:
 * listing / fetching dispute tickets and triggering state changes (including
 * manual refunds).  All routes are mounted behind adminMiddleware, so every
 * handler runs with operator privileges.
 */

import { Request, Response } from "express";
import { sendApiError } from "../lib/apiError.js";
import {
  disputeService,
  DISPUTE_STATUSES,
  DisputeStatus,
} from "../services/disputeService";

/** Best-effort operator identity captured from the admin context. */
function extractAdminIdentity(req: Request): string {
  const fromContext = (req as { admin?: { publicKey?: string } }).admin
    ?.publicKey;
  const fromHeader = Array.isArray(req.headers["x-admin-key"])
    ? String(req.headers["x-admin-key"]?.[0] ?? "")
    : String(req.headers["x-admin-key"] ?? "");
  return fromContext || fromHeader || "admin";
}

const NOT_FOUND_ERROR = "Dispute ticket not found";

/** GET /api/admin/remittance/disputes */
export const listDisputes = async (req: Request, res: Response) => {
  try {
    const rawStatus = req.query.status as string | undefined;
    let status: DisputeStatus | undefined;
    if (rawStatus !== undefined && rawStatus !== "") {
      const normalized = rawStatus.toLowerCase();
      if (!DISPUTE_STATUSES.includes(normalized as DisputeStatus)) {
        sendApiError(
          res,
          400,
          "BAD_REQUEST",
          `Invalid status. Must be one of: ${DISPUTE_STATUSES.join(", ")}`,
        );
        return;
      }
      status = normalized as DisputeStatus;
    }

    const userId = req.query.userId as string | undefined;
    const limit = parseInt(req.query.limit as string, 10);
    const offset = parseInt(req.query.offset as string, 10);

    const result = await disputeService.listDisputes({
      ...(status ? { status } : {}),
      ...(userId ? { userId } : {}),
      ...(!isNaN(limit) ? { limit } : {}),
      ...(!isNaN(offset) ? { offset } : {}),
    });

    if (!result.success) {
      sendApiError(res, 500, "INTERNAL_SERVER_ERROR", result.error);
      return;
    }

    res.json({ success: true, data: result.data, total: result.total });
  } catch (error) {
    sendApiError(
      res,
      500,
      "INTERNAL_SERVER_ERROR",
      error instanceof Error ? error.message : "Failed to list disputes",
    );
  }
};

/** GET /api/admin/remittance/disputes/:id */
export const getDisputeById = async (req: Request, res: Response) => {
  try {
    const result = await disputeService.getDispute(req.params.id as string);

    if (!result.success) {
      sendApiError(
        res,
        result.error === NOT_FOUND_ERROR ? 404 : 500,
        result.error === NOT_FOUND_ERROR ? "NOT_FOUND" : "INTERNAL_SERVER_ERROR",
        result.error,
      );
      return;
    }

    res.json({ success: true, data: result.dispute });
  } catch (error) {
    sendApiError(
      res,
      500,
      "INTERNAL_SERVER_ERROR",
      error instanceof Error ? error.message : "Failed to fetch dispute",
    );
  }
};

/** POST /api/admin/remittance/disputes/:id/status */
export const transitionDisputeStatus = async (req: Request, res: Response) => {
  try {
    const { status, email, webhookUrl } = (req.body ?? {}) as {
      status?: string;
      email?: string;
      webhookUrl?: string;
    };

    if (!status || !DISPUTE_STATUSES.includes(status as DisputeStatus)) {
      sendApiError(
        res,
        400,
        "BAD_REQUEST",
        `Invalid status. Must be one of: ${DISPUTE_STATUSES.join(", ")}`,
      );
      return;
    }

    const result = await disputeService.transitionStatus(
      req.params.id as string,
      {
        toStatus: status as DisputeStatus,
        byId: extractAdminIdentity(req),
        ...(email ? { email } : {}),
        ...(webhookUrl ? { webhookUrl } : {}),
      },
    );

    if (!result.success) {
      const isNotFound = result.error === NOT_FOUND_ERROR;
      const isConflict = result.error?.includes("Cannot transition");
      sendApiError(
        res,
        isNotFound ? 404 : isConflict ? 409 : 500,
        isNotFound
          ? "NOT_FOUND"
          : isConflict
            ? "CONFLICT"
            : "INTERNAL_SERVER_ERROR",
        result.error,
      );
      return;
    }

    res.json({ success: true, data: result.dispute });
  } catch (error) {
    sendApiError(
      res,
      500,
      "INTERNAL_SERVER_ERROR",
      error instanceof Error ? error.message : "Failed to update dispute status",
    );
  }
};

/** POST /api/admin/remittance/disputes/:id/refund */
export const triggerManualRefund = async (req: Request, res: Response) => {
  try {
    const { refundAmount, email, webhookUrl } = (req.body ?? {}) as {
      refundAmount?: number;
      email?: string;
      webhookUrl?: string;
    };

    if (
      refundAmount !== undefined &&
      (typeof refundAmount !== "number" ||
        !isFinite(refundAmount) ||
        refundAmount < 0)
    ) {
      sendApiError(
        res,
        400,
        "BAD_REQUEST",
        "refundAmount must be a non-negative number",
      );
      return;
    }

    const result = await disputeService.triggerManualRefund(
      req.params.id as string,
      {
        ...(refundAmount !== undefined ? { refundAmount } : {}),
        byId: extractAdminIdentity(req),
        ...(email ? { email } : {}),
        ...(webhookUrl ? { webhookUrl } : {}),
      },
    );

    if (!result.success) {
      const isNotFound = result.error === NOT_FOUND_ERROR;
      const isConflict = result.error?.includes("already been closed");
      sendApiError(
        res,
        isNotFound ? 404 : isConflict ? 409 : 500,
        isNotFound
          ? "NOT_FOUND"
          : isConflict
            ? "CONFLICT"
            : "INTERNAL_SERVER_ERROR",
        result.error,
      );
      return;
    }

    res.json({ success: true, data: result.dispute });
  } catch (error) {
    sendApiError(
      res,
      500,
      "INTERNAL_SERVER_ERROR",
      error instanceof Error ? error.message : "Failed to trigger manual refund",
    );
  }
};