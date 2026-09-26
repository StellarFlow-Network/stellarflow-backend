import { Request, Response } from "express";
import { sendApiError } from "../lib/apiError.js";
import {
  governanceWebhookBroadcaster,
  normalizeGovernanceWebhookEvents,
  type GovernanceWebhookEventType,
} from "../services/governanceWebhookBroadcaster.js";

function parseBoolean(value: unknown, fallback: boolean): boolean {
  if (value === undefined || value === null || value === "") {
    return fallback;
  }
  if (typeof value === "boolean") {
    return value;
  }
  const normalized = String(value).trim().toLowerCase();
  if (["true", "1", "yes", "y"].includes(normalized)) {
    return true;
  }
  if (["false", "0", "no", "n"].includes(normalized)) {
    return false;
  }
  return fallback;
}

function isValidUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

function parseEvents(
  value: unknown,
): GovernanceWebhookEventType[] | undefined {
  if (value === undefined || value === null || value === "") {
    return undefined;
  }
  const raw = Array.isArray(value) ? value : String(value).split(",");
  return normalizeGovernanceWebhookEvents(
    raw.map((event) => String(event).trim()).filter((event) => event.length > 0),
  );
}

export async function listGovernanceWebhookEndpoints(
  req: Request,
  res: Response,
): Promise<void> {
  try {
    const includeInactive = parseBoolean(req.query.includeInactive, false);
    const endpoints =
      await governanceWebhookBroadcaster.listEndpoints(includeInactive);
    res.json({ success: true, data: { endpoints } });
  } catch (error) {
    console.error(
      "[GovernanceWebhookController] listEndpoints error:",
      error,
    );
    sendApiError(
      res,
      500,
      "INTERNAL_SERVER_ERROR",
      "Failed to retrieve governance webhook endpoints",
    );
  }
}

export async function registerGovernanceWebhookEndpoint(
  req: Request,
  res: Response,
): Promise<void> {
  try {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const url = typeof body.url === "string" ? body.url.trim() : "";

    if (!url || !isValidUrl(url)) {
      return sendApiError(
        res,
        400,
        "BAD_REQUEST",
        "A valid http(s) 'url' is required",
      );
    }

    const secret =
      typeof body.secret === "string" && body.secret.trim().length > 0
        ? body.secret.trim()
        : undefined;

    if (secret !== undefined && secret.length < 16) {
      return sendApiError(
        res,
        400,
        "BAD_REQUEST",
        "Webhook secret must be at least 16 characters",
      );
    }

    const name = typeof body.name === "string" ? body.name.trim() : undefined;
    const events = parseEvents(body.events);
    const active = parseBoolean(body.active, true);

    const endpoint = await governanceWebhookBroadcaster.registerEndpoint({
      url,
      ...(name !== undefined && name.length > 0 ? { name } : {}),
      ...(secret !== undefined ? { secret } : {}),
      ...(events !== undefined ? { events } : {}),
      active,
    });

    res.status(201).json({ success: true, data: { endpoint } });
  } catch (error) {
    console.error(
      "[GovernanceWebhookController] registerEndpoint error:",
      error,
    );
    sendApiError(
      res,
      500,
      "INTERNAL_SERVER_ERROR",
      "Failed to register governance webhook endpoint",
    );
  }
}

export async function deactivateGovernanceWebhookEndpoint(
  req: Request,
  res: Response,
): Promise<void> {
  try {
    const id = req.params.id as string;
    if (!id) {
      return sendApiError(res, 400, "BAD_REQUEST", "Endpoint id is required");
    }

    const deactivated =
      await governanceWebhookBroadcaster.deactivateEndpoint(id);

    if (!deactivated) {
      return sendApiError(
        res,
        404,
        "NOT_FOUND",
        "Governance webhook endpoint not found or already inactive",
      );
    }

    res.json({ success: true, data: { id, active: false } });
  } catch (error) {
    console.error(
      "[GovernanceWebhookController] deactivateEndpoint error:",
      error,
    );
    sendApiError(
      res,
      500,
      "INTERNAL_SERVER_ERROR",
      "Failed to deactivate governance webhook endpoint",
    );
  }
}

export async function listGovernanceWebhookDeliveries(
  req: Request,
  res: Response,
): Promise<void> {
  try {
    const limitRaw = parseInt((req.query.limit as string) ?? "50", 10);
    const offsetRaw = parseInt((req.query.offset as string) ?? "0", 10);

    const filters = {
      limit: Math.min(Math.max(Number.isNaN(limitRaw) ? 50 : limitRaw, 1), 200),
      offset: Math.max(Number.isNaN(offsetRaw) ? 0 : offsetRaw, 0),
      ...(typeof req.query.endpointId === "string" && req.query.endpointId
        ? { endpointId: req.query.endpointId }
        : {}),
      ...(typeof req.query.eventType === "string" && req.query.eventType
        ? { eventType: req.query.eventType }
        : {}),
      ...(typeof req.query.proposalId === "string" && req.query.proposalId
        ? { proposalId: req.query.proposalId }
        : {}),
      ...(typeof req.query.status === "string" && req.query.status
        ? { status: req.query.status }
        : {}),
    };

    const history =
      await governanceWebhookBroadcaster.getDeliveryHistory(filters);

    res.json({
      success: true,
      data: {
        deliveries: history.deliveries,
        pagination: {
          total: history.total,
          limit: history.limit,
          offset: history.offset,
        },
      },
    });
  } catch (error) {
    console.error(
      "[GovernanceWebhookController] listDeliveries error:",
      error,
    );
    sendApiError(
      res,
      500,
      "INTERNAL_SERVER_ERROR",
      "Failed to retrieve governance webhook delivery history",
    );
  }
}

export async function getGovernanceWebhookDeliveryStats(
  _req: Request,
  res: Response,
): Promise<void> {
  try {
    const stats = await governanceWebhookBroadcaster.getDeliveryStats();
    res.json({ success: true, data: stats });
  } catch (error) {
    console.error(
      "[GovernanceWebhookController] getDeliveryStats error:",
      error,
    );
    sendApiError(
      res,
      500,
      "INTERNAL_SERVER_ERROR",
      "Failed to retrieve governance webhook delivery stats",
    );
  }
}
