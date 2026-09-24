import { Router } from "express";
import { sendApiError } from "../lib/apiError.js";
import {
  PaymentRoutingService,
  RouteCreateParams,
} from "../services/paymentRoutingService";
import { FxConversionService } from "../services/fxConversionService";

const paymentRoutingService = new PaymentRoutingService();
const fxConversionService = new FxConversionService();

const router = Router();

// Find optimal liquidity routes for a remittance payment
router.post("/routes", async (req, res) => {
  try {
    const { senderCurrency, receiverCurrency, inputAmount, targetRail } =
      req.body ?? {};

    if (!senderCurrency || !receiverCurrency || inputAmount === undefined) {
      sendApiError(
        res,
        400,
        "BAD_REQUEST",
        "senderCurrency, receiverCurrency, and inputAmount are required",
      );
      return;
    }

    const result = await paymentRoutingService.findOptimalRoutes({
      senderCurrency,
      receiverCurrency,
      inputAmount: Number(inputAmount),
      targetRail,
    });

    if (result.success) {
      res.json({ success: true, data: result });
    } else {
      sendApiError(res, 404, "NOT_FOUND", result.error);
    }
  } catch (error) {
    sendApiError(
      res,
      500,
      "INTERNAL_SERVER_ERROR",
      error instanceof Error ? error.message : "Failed to find optimal routes",
    );
  }
});

// Create a new payment route
router.post("/routes/create", async (req, res) => {
  try {
    const {
      senderCurrency,
      receiverCurrency,
      sourceAsset,
      targetRail,
      provider,
      rate,
      fee,
      estimatedAmount,
      slippageBps,
      liquidityPoolId,
      priority,
    } = req.body ?? {};

    if (
      !senderCurrency ||
      !receiverCurrency ||
      !sourceAsset ||
      !targetRail ||
      !provider ||
      rate === undefined ||
      fee === undefined ||
      estimatedAmount === undefined
    ) {
      sendApiError(
        res,
        400,
        "BAD_REQUEST",
        "senderCurrency, receiverCurrency, sourceAsset, targetRail, provider, rate, fee, and estimatedAmount are required",
      );
      return;
    }

    const params: RouteCreateParams = {
      senderCurrency,
      receiverCurrency,
      sourceAsset,
      targetRail,
      provider,
      rate: Number(rate),
      fee: Number(fee),
      estimatedAmount: Number(estimatedAmount),
      ...(slippageBps !== undefined
        ? { slippageBps: Number(slippageBps) }
        : {}),
      ...(liquidityPoolId !== undefined ? { liquidityPoolId } : {}),
      ...(priority !== undefined ? { priority: Number(priority) } : {}),
    };

    const route = await paymentRoutingService.createRoute(params);
    res.status(201).json({ success: true, data: route });
  } catch (error) {
    sendApiError(
      res,
      500,
      "INTERNAL_SERVER_ERROR",
      error instanceof Error ? error.message : "Failed to create payment route",
    );
  }
});

// List payment routes with optional filters
router.get("/routes", async (req, res) => {
  try {
    const { senderCurrency, receiverCurrency, targetRail, status } =
      req.query ?? {};

    const filters: {
      senderCurrency?: string;
      receiverCurrency?: string;
      targetRail?: string;
      status?: string;
    } = {};

    if (typeof senderCurrency === "string" && senderCurrency.length > 0) {
      filters.senderCurrency = senderCurrency;
    }
    if (typeof receiverCurrency === "string" && receiverCurrency.length > 0) {
      filters.receiverCurrency = receiverCurrency;
    }
    if (typeof targetRail === "string" && targetRail.length > 0) {
      filters.targetRail = targetRail;
    }
    if (typeof status === "string" && status.length > 0) {
      filters.status = status;
    }

    const routes = await paymentRoutingService.listRoutes(filters);

    res.json({ success: true, data: routes });
  } catch (error) {
    sendApiError(
      res,
      500,
      "INTERNAL_SERVER_ERROR",
      error instanceof Error ? error.message : "Failed to list payment routes",
    );
  }
});

// Get a single route by ID
router.get("/routes/:id", async (req, res) => {
  try {
    const route = await paymentRoutingService.getRouteById(req.params.id);
    if (!route) {
      sendApiError(res, 404, "NOT_FOUND", "Payment route not found");
      return;
    }
    res.json({ success: true, data: route });
  } catch (error) {
    sendApiError(
      res,
      500,
      "INTERNAL_SERVER_ERROR",
      error instanceof Error ? error.message : "Failed to get payment route",
    );
  }
});

// Update route status
router.patch("/routes/:id/status", async (req, res) => {
  try {
    const { status } = req.body ?? {};
    if (!status || !["ACTIVE", "PAUSED", "RETIRED"].includes(status)) {
      sendApiError(
        res,
        400,
        "BAD_REQUEST",
        "status must be ACTIVE, PAUSED, or RETIRED",
      );
      return;
    }

    const route = await paymentRoutingService.updateRouteStatus(
      req.params.id,
      status,
    );
    if (!route) {
      sendApiError(res, 404, "NOT_FOUND", "Payment route not found");
      return;
    }
    res.json({ success: true, data: route });
  } catch (error) {
    sendApiError(
      res,
      500,
      "INTERNAL_SERVER_ERROR",
      error instanceof Error ? error.message : "Failed to update route status",
    );
  }
});

// Request an FX quote for a specific route
router.post("/quotes", async (req, res) => {
  try {
    const { routeId, inputAmount, quoteTtlMs, userAddress } = req.body ?? {};

    if (!routeId || inputAmount === undefined) {
      sendApiError(
        res,
        400,
        "BAD_REQUEST",
        "routeId and inputAmount are required",
      );
      return;
    }

    const result = await fxConversionService.requestQuote(
      routeId,
      Number(inputAmount),
      {
        ...(quoteTtlMs !== undefined
          ? { quoteTtlMs: Number(quoteTtlMs) }
          : {}),
        ...(typeof userAddress === "string" && userAddress.trim().length > 0
          ? { userAddress: userAddress.trim() }
          : {}),
      },
    );

    if (result.success) {
      res.status(201).json({ success: true, data: result });
    } else {
      sendApiError(res, 400, "BAD_REQUEST", result.error);
    }
  } catch (error) {
    sendApiError(
      res,
      500,
      "INTERNAL_SERVER_ERROR",
      error instanceof Error ? error.message : "Failed to request FX quote",
    );
  }
});

// Lock a pending quote after verifying against live feed
router.post("/quotes/:id/lock", async (req, res) => {
  try {
    const result = await fxConversionService.lockQuote({
      quoteId: req.params.id,
    });

    if (result.success) {
      res.json({ success: true, data: result });
    } else {
      sendApiError(res, 400, "BAD_REQUEST", result.error);
    }
  } catch (error) {
    sendApiError(
      res,
      500,
      "INTERNAL_SERVER_ERROR",
      error instanceof Error ? error.message : "Failed to lock quote",
    );
  }
});

// Get quote status
router.get("/quotes/:id", async (req, res) => {
  try {
    const quote = await fxConversionService.getQuoteStatus(req.params.id);
    if (!quote) {
      sendApiError(res, 404, "NOT_FOUND", "FX quote not found");
      return;
    }
    res.json({ success: true, data: quote });
  } catch (error) {
    sendApiError(
      res,
      500,
      "INTERNAL_SERVER_ERROR",
      error instanceof Error ? error.message : "Failed to get quote status",
    );
  }
});

export default router;
