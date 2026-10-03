import { Request, Response } from "express";
import { sendApiError } from "../lib/apiError.js";
import { timelockService } from "../services/timelockService.js";

/**
 * GET /api/v1/admin/timelocks
 * List queued, executed, and cancelled timelock actions with ETA countdowns.
 * Supports filtering by contractId and actionType.
 */
export async function listTimelocks(
  req: Request,
  res: Response,
): Promise<void> {
  try {
    const status = (req.query.status as string) || undefined;
    const contractId = (req.query.contractId as string) || undefined;
    const actionType = (req.query.actionType as string) || undefined;
    const limitRaw = parseInt((req.query.limit as string) ?? "50", 10);
    const offsetRaw = parseInt((req.query.offset as string) ?? "0", 10);

    const limit = Math.min(Math.max(isNaN(limitRaw) ? 50 : limitRaw, 1), 200);
    const offset = Math.max(isNaN(offsetRaw) ? 0 : offsetRaw, 0);

    if (status) {
      const validStatuses = ["Queued", "Executed", "Cancelled", "Expired", "EXPIRED"];
      if (!validStatuses.includes(status)) {
        return sendApiError(
          res,
          400,
          "BAD_REQUEST",
          `Invalid status. Must be one of: Queued, Executed, Cancelled, Expired`,
        );
      }
    }

    const filters: import("../services/timelockService.js").TimelockListFilters =
      { limit, offset };
    if (status !== undefined) filters.status = status;
    if (contractId !== undefined) filters.contractId = contractId;
    if (actionType !== undefined) filters.actionType = actionType;

    const { entries, total } = await timelockService.listActions(filters);

    const enriched = entries.map((entry) => {
      const eta =
        entry.status === "Queued"
          ? timelockService.computeETA(new Date(entry.expiresAt))
          : null;

      return {
        id: entry.id,
        proposalId: entry.proposalId,
        contractId: entry.contractId,
        actionType: entry.actionType,
        actionData: entry.actionData,
        status: entry.status,
        expiresAt: new Date(entry.expiresAt).toISOString(),
        transactionHash: entry.transactionHash,
        executedAt: entry.executedAt
          ? new Date(entry.executedAt).toISOString()
          : null,
        cancelledAt: entry.cancelledAt
          ? new Date(entry.cancelledAt).toISOString()
          : null,
        createdAt: new Date(entry.createdAt).toISOString(),
        updatedAt: new Date(entry.updatedAt).toISOString(),
        eta,
      };
    });

    res.json({
      success: true,
      data: {
        actions: enriched,
        pagination: { total, limit, offset },
      },
    });
  } catch (error) {
    console.error("[TimelockController] listTimelocks error:", error);
    sendApiError(
      res,
      500,
      "INTERNAL_SERVER_ERROR",
      "Failed to retrieve timelock actions",
    );
  }
}

/**
 * GET /api/v1/admin/timelocks/:id
 * Get a single timelock action by ID with ETA countdown.
 */
export async function getTimelockById(
  req: Request,
  res: Response,
): Promise<void> {
  try {
    const id = parseInt(req.params.id as string, 10);
    if (isNaN(id)) {
      return sendApiError(res, 400, "BAD_REQUEST", "Invalid timelock ID");
    }

    const entry = await timelockService.getActionById(id);
    if (!entry) {
      return sendApiError(res, 404, "NOT_FOUND", "Timelock action not found");
    }

    const eta =
      entry.status === "Queued"
        ? timelockService.computeETA(new Date(entry.expiresAt))
        : null;

    res.json({
      success: true,
      data: {
        id: entry.id,
        proposalId: entry.proposalId,
        contractId: entry.contractId,
        actionType: entry.actionType,
        actionData: entry.actionData,
        status: entry.status,
        expiresAt: new Date(entry.expiresAt).toISOString(),
        transactionHash: entry.transactionHash,
        executedAt: entry.executedAt
          ? new Date(entry.executedAt).toISOString()
          : null,
        cancelledAt: entry.cancelledAt
          ? new Date(entry.cancelledAt).toISOString()
          : null,
        createdAt: new Date(entry.createdAt).toISOString(),
        updatedAt: new Date(entry.updatedAt).toISOString(),
        eta,
      },
    });
  } catch (error) {
    console.error("[TimelockController] getTimelockById error:", error);
    sendApiError(
      res,
      500,
      "INTERNAL_SERVER_ERROR",
      "Failed to retrieve timelock action",
    );
  }
}

/**
 * GET /api/v1/admin/timelocks/summary
 * Aggregate counts of queued, executed, and cancelled actions.
 */
export async function getTimelockSummary(
  _req: Request,
  res: Response,
): Promise<void> {
  try {
    const summary = await timelockService.getStatusCounts();
    res.json({ success: true, data: summary });
  } catch (error) {
    console.error("[TimelockController] getTimelockSummary error:", error);
    sendApiError(
      res,
      500,
      "INTERNAL_SERVER_ERROR",
      "Failed to retrieve timelock summary",
    );
  }
}

/**
 * POST /api/v1/admin/timelocks/:id/cancel
 * Cancel a queued timelock action.
 */
export async function cancelTimelock(
  req: Request,
  res: Response,
): Promise<void> {
  try {
    const id = parseInt(req.params.id as string, 10);
    if (isNaN(id)) {
      return sendApiError(res, 400, "BAD_REQUEST", "Invalid timelock ID");
    }

    const updated = await timelockService.cancelAction(id);
    if (!updated) {
      return sendApiError(
        res,
        404,
        "NOT_FOUND",
        "Timelock action not found or not in Queued status",
      );
    }

    res.json({
      success: true,
      data: {
        id: updated.id,
        proposalId: updated.proposalId,
        status: updated.status,
        cancelledAt: updated.cancelledAt
          ? new Date(updated.cancelledAt).toISOString()
          : null,
      },
    });
  } catch (error) {
    console.error("[TimelockController] cancelTimelock error:", error);
    sendApiError(
      res,
      500,
      "INTERNAL_SERVER_ERROR",
      "Failed to cancel timelock action",
    );
  }
}
