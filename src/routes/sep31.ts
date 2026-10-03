import { Request, Response, Router } from "express";
import { sendApiError } from "../lib/apiError.js";
import {
  Sep31Service,
  Sep31ValidationError,
} from "../services/sep31Service";

const router = Router();
const sep31 = new Sep31Service();

function authenticatedUserId(req: Request): string | null {
  const user = (req as Request & { user?: { userId?: string | number } }).user;
  return user?.userId === undefined ? null : String(user.userId);
}

function transactionId(req: Request): string {
  const value = req.params.id;
  return Array.isArray(value) ? value[0] ?? "" : value ?? "";
}

function handleError(res: Response, error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  if (error instanceof Sep31ValidationError) {
    sendApiError(res, 400, "SEP31_BAD_REQUEST", message);
    return;
  }
  if (message.includes("not found")) {
    sendApiError(res, 404, "SEP31_NOT_FOUND", message);
    return;
  }
  if (message.includes("disabled")) {
    sendApiError(res, 503, "SEP31_DISABLED", message);
    return;
  }
  console.error("[SEP-31] Request failed:", error);
  sendApiError(res, 502, "SEP31_UPSTREAM_ERROR", "SEP-31 request could not be completed");
}

router.get("/info", (_req: Request, res: Response) => {
  try {
    res.json(sep31.getInfo());
  } catch (error) {
    handleError(res, error);
  }
});

router.post("/transactions", async (req: Request, res: Response) => {
  const userId = authenticatedUserId(req);
  if (!userId) {
    sendApiError(res, 401, "UNAUTHORIZED", "Authentication required");
    return;
  }
  try {
    const transaction = await sep31.createTransaction(userId, req.body);
    res.status(201).json({
      id: transaction.id,
      status: "pending_sender",
      amount_in: transaction.amount.toString(),
      amount_out: transaction.outputAmount.toString(),
      fee: transaction.fee.toString(),
      source_asset: transaction.source.id,
      destination_asset: transaction.destination.id,
    });
  } catch (error) {
    handleError(res, error);
  }
});

router.get("/transactions/:id", async (req: Request, res: Response) => {
  const userId = authenticatedUserId(req);
  if (!userId) {
    sendApiError(res, 401, "UNAUTHORIZED", "Authentication required");
    return;
  }
  try {
    const transaction = await sep31.getTransaction(transactionId(req), userId);
    if (!transaction) {
      sendApiError(res, 404, "SEP31_NOT_FOUND", "SEP-31 transaction not found");
      return;
    }
    res.json({
      id: transaction.id,
      status: transaction.status.toLowerCase(),
      amount_in: transaction.amount.toString(),
      amount_out: transaction.outputAmount.toString(),
      fee: transaction.fee.toString(),
      source_asset: transaction.source.id,
      destination_asset: transaction.destination.id,
      sender: transaction.sender,
      receiver: transaction.receiver,
      callback: transaction.callbackUrl,
      created_at: transaction.createdAt.toISOString(),
    });
  } catch (error) {
    handleError(res, error);
  }
});

router.put("/transactions/:id/callback", async (req: Request, res: Response) => {
  const userId = authenticatedUserId(req);
  if (!userId) {
    sendApiError(res, 401, "UNAUTHORIZED", "Authentication required");
    return;
  }
  try {
    const callback = await sep31.registerCallback(
      transactionId(req),
      userId,
      req.body?.url ?? req.body?.callback,
    );
    res.json(callback);
  } catch (error) {
    handleError(res, error);
  }
});

export default router;