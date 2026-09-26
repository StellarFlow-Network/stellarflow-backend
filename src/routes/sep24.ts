/**
 * SEP-24 Interactive Flow Routes – Issue #1015
 *
 * Two routers, because they are reached differently:
 *
 *  - `sep24InitiationRouter`, mounted at /api/v1/sep24 behind the normal /api
 *    authentication chain. Wallets POST here to start a deposit or withdrawal.
 *      POST /transactions/deposit/interactive
 *      POST /transactions/withdraw/interactive
 *
 *  - `sep24InteractiveRouter`, mounted at /sep24 *outside* the JSON-API
 *    security chain. It serves the webview a user opens in their browser, which
 *    can't send API keys or bearer tokens; the signed `token` in the URL is the
 *    credential. It sets its own strict, nonce-based CSP so wallets can frame
 *    it, which the API-wide `frame-ancestors 'none'` policy would forbid.
 *      GET  /interactive   render the payout-details form
 *      POST /interactive   validate, store, and hand the wallet a completion token
 *
 * Configuration (see .env.example): SEP24_INTERACTIVE_SECRET,
 * SEP24_INTERACTIVE_BASE_URL, SEP24_ALLOWED_CALLBACK_ORIGINS, ...
 * When unset, every endpoint answers 503 rather than running unsigned.
 */

import crypto from "node:crypto";
import express, { Router, type Request, type Response } from "express";
import { getRedisClient } from "../lib/redis.js";
import { rateLimitMiddleware } from "../middleware/rateLimitMiddleware.js";
import {
  InMemorySep24SessionStore,
  RedisSep24SessionStore,
  Sep24Error,
  Sep24InteractiveService,
  deliverUrlCallback,
  sep24ConfigFromEnv,
  type FetchLike,
  type RedisLike,
  type Sep24Operation,
} from "../services/sep24Interactive.js";
import {
  renderComplete,
  renderForm,
  renderMessage,
  type FormValues,
} from "../services/sep24InteractiveView.js";

// ─── Service wiring ───────────────────────────────────────────────────────────

let cachedService: Sep24InteractiveService | null | undefined;

/** Lazily built so importing this module never requires configuration. */
export function getSep24Service(): Sep24InteractiveService | null {
  if (cachedService !== undefined) return cachedService;

  const config = sep24ConfigFromEnv();
  if (!config) {
    cachedService = null;
    return null;
  }

  const redis = getRedisClient();
  const store =
    redis && redis.isOpen
      ? new RedisSep24SessionStore(redis as unknown as RedisLike)
      : new InMemorySep24SessionStore();
  if (!(redis && redis.isOpen) && process.env.NODE_ENV === "production") {
    console.warn(
      "[SEP-24] Redis unavailable: sessions are held in memory and will not survive restarts or span instances.",
    );
  }

  cachedService = new Sep24InteractiveService(store, config);
  return cachedService;
}

export interface Sep24RouterOptions {
  /** Resolves the service per request; defaults to the env-configured one. */
  getService?: () => Sep24InteractiveService | null;
  fetchImpl?: FetchLike;
  /** Disable rate limiting (unit tests). */
  rateLimit?: boolean;
}

// ─── Shared helpers ───────────────────────────────────────────────────────────

const STATUS_BY_CODE: Record<Sep24Error["code"], number> = {
  INVALID_TOKEN: 400,
  EXPIRED_TOKEN: 410,
  SESSION_NOT_FOUND: 404,
  ALREADY_SUBMITTED: 409,
  VALIDATION_ERROR: 422,
  CALLBACK_NOT_ALLOWED: 400,
  UNSUPPORTED_ASSET: 400,
};

const single = (value: unknown): string | undefined =>
  typeof value === "string" ? value : undefined;

// ─── Initiation (authenticated JSON API) ──────────────────────────────────────

export function createSep24InitiationRouter(options: Sep24RouterOptions = {}): Router {
  const router = Router();
  const getService = options.getService ?? getSep24Service;

  /**
   * @swagger
   * /api/v1/sep24/transactions/{operation}/interactive:
   *   post:
   *     tags: [Anchors]
   *     summary: Start a SEP-24 interactive deposit or withdrawal
   *     description: >
   *       Creates an interactive session and returns the URL the wallet opens in
   *       a webview. Responses follow SEP-24 (`{ type, url, id }`; errors are
   *       `{ error }`).
   *     parameters:
   *       - in: path
   *         name: operation
   *         required: true
   *         schema: { type: string, enum: [deposit, withdraw] }
   *     requestBody:
   *       required: true
   *       content:
   *         application/json:
   *           schema:
   *             type: object
   *             required: [asset_code]
   *             properties:
   *               asset_code: { type: string, example: USDC }
   *               account:    { type: string, description: Stellar public key of the user }
   *               amount:     { type: string, example: "100.50" }
   *               wallet_url: { type: string, description: Wallet origin; used as the postMessage target when allow-listed }
   *     responses:
   *       '200':
   *         description: Interactive session created
   *         content:
   *           application/json:
   *             schema:
   *               type: object
   *               properties:
   *                 type: { type: string, example: interactive_customer_info_needed }
   *                 url:  { type: string }
   *                 id:   { type: string }
   *       '400': { description: Invalid request }
   *       '503': { description: SEP-24 is not configured }
   */
  router.post(
    "/transactions/:operation/interactive",
    async (req: Request, res: Response): Promise<void> => {
      const service = getService();
      if (!service) {
        res.status(503).json({ error: "SEP-24 interactive flow is not configured." });
        return;
      }

      const operation = req.params.operation;
      if (operation !== "deposit" && operation !== "withdraw") {
        res.status(404).json({ error: "Unknown operation." });
        return;
      }

      const body = (req.body ?? {}) as Record<string, unknown>;
      try {
        const result = await service.initiate({
          operation: operation as Sep24Operation,
          assetCode: body.asset_code,
          account: body.account,
          amount: body.amount,
          walletUrl: body.wallet_url,
        });
        res.json(result);
      } catch (err) {
        if (err instanceof Sep24Error) {
          // SEP-24 specifies 400 for a bad request; 422 is reserved for the webview form.
          const status = err.code === "VALIDATION_ERROR" ? 400 : STATUS_BY_CODE[err.code];
          res.status(status).json({ error: err.message });
          return;
        }
        console.error("[SEP-24] initiation failed:", err);
        res.status(500).json({ error: "Internal server error." });
      }
    },
  );

  return router;
}

// ─── Webview (browser-facing) ─────────────────────────────────────────────────

export function createSep24InteractiveRouter(options: Sep24RouterOptions = {}): Router {
  const router = Router();
  const getService = options.getService ?? getSep24Service;

  if (options.rateLimit !== false) router.use(rateLimitMiddleware());
  router.use(express.urlencoded({ extended: false, limit: "16kb" }));

  /** Send an HTML page with the webview's own security headers. */
  function sendHtml(
    res: Response,
    status: number,
    nonce: string,
    html: string,
    frameAncestors: string[],
  ): void {
    res
      .status(status)
      .set({
        "Content-Type": "text/html; charset=utf-8",
        "Content-Security-Policy": [
          "default-src 'none'",
          `style-src 'nonce-${nonce}'`,
          `script-src 'nonce-${nonce}'`,
          "form-action 'self'",
          "base-uri 'none'",
          `frame-ancestors ${["'self'", ...frameAncestors].join(" ")}`,
        ].join("; "),
        // The URL carries a bearer token: never leak it via Referer, never cache.
        "Referrer-Policy": "no-referrer",
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
        "Strict-Transport-Security": "max-age=31536000; includeSubDomains",
      })
      .send(html);
  }

  const newNonce = (): string => crypto.randomBytes(16).toString("base64");

  function sendError(
    res: Response,
    service: Sep24InteractiveService | null,
    err: unknown,
  ): void {
    const nonce = newNonce();
    const ancestors = service?.config.allowedCallbackOrigins ?? [];
    if (err instanceof Sep24Error) {
      sendHtml(
        res,
        STATUS_BY_CODE[err.code],
        nonce,
        renderMessage({ nonce, title: "Unable to continue", message: err.message }),
        ancestors,
      );
      return;
    }
    console.error("[SEP-24] webview error:", err);
    sendHtml(
      res,
      500,
      nonce,
      renderMessage({
        nonce,
        title: "Something went wrong",
        message: "Please go back to your wallet and try again.",
      }),
      ancestors,
    );
  }

  function sendUnavailable(res: Response): void {
    const nonce = newNonce();
    sendHtml(
      res,
      503,
      nonce,
      renderMessage({
        nonce,
        title: "Service unavailable",
        message: "This service is not available right now. Please try again later.",
      }),
      [],
    );
  }

  /**
   * @swagger
   * /sep24/interactive:
   *   get:
   *     tags: [Anchors]
   *     summary: SEP-24 interactive webview
   *     description: >
   *       Responsive form collecting payout details for a SEP-24 deposit or
   *       withdrawal. Opened by the wallet using the URL from the initiation
   *       response. Not part of the JSON API.
   *     parameters:
   *       - in: query
   *         name: token
   *         required: true
   *         schema: { type: string }
   *       - in: query
   *         name: callback
   *         schema: { type: string }
   *         description: "`postMessage` or an allow-listed https URL."
   *     responses:
   *       '200': { description: HTML form }
   *       '400': { description: Invalid token or callback }
   *       '410': { description: Link expired }
   *   post:
   *     tags: [Anchors]
   *     summary: Submit SEP-24 payout details
   *     description: >
   *       Validates and stores the details, moves the transaction to
   *       pending_user_transfer_start and returns the wallet a signed completion
   *       token via the requested callback.
   *     requestBody:
   *       required: true
   *       content:
   *         application/x-www-form-urlencoded:
   *           schema:
   *             type: object
   *             required: [token, full_name, bank_name, account_number]
   *             properties:
   *               token:          { type: string }
   *               callback:       { type: string }
   *               full_name:      { type: string }
   *               bank_name:      { type: string }
   *               account_number: { type: string }
   *               email:          { type: string }
   *               amount:         { type: string }
   *     responses:
   *       '200': { description: Completion page }
   *       '409': { description: Already submitted }
   *       '422': { description: Validation errors (form re-rendered) }
   */
  router.get("/interactive", async (req: Request, res: Response): Promise<void> => {
    const service = getService();
    if (!service) {
      sendUnavailable(res);
      return;
    }

    try {
      const token = single(req.query.token) ?? "";
      const session = await service.openSession(token);
      if (session.sealedPayout) {
        throw new Sep24Error("ALREADY_SUBMITTED", "This form has already been submitted.");
      }
      // Reject a bad callback before the user fills anything in.
      const callback = single(req.query.callback);
      service.resolveCallback(callback, session);

      const nonce = newNonce();
      sendHtml(
        res,
        200,
        nonce,
        renderForm({ nonce, token, session, ...(callback ? { callback } : {}) }),
        service.config.allowedCallbackOrigins,
      );
    } catch (err) {
      sendError(res, service, err);
    }
  });

  router.post("/interactive", async (req: Request, res: Response): Promise<void> => {
    const service = getService();
    if (!service) {
      sendUnavailable(res);
      return;
    }

    const form = (req.body ?? {}) as Record<string, unknown>;
    const token = single(form.token) ?? "";
    const callback = single(form.callback);

    try {
      const result = await service.submit(token, form);

      let delivered: boolean | undefined;
      if (result.callback.kind === "url") {
        delivered = await deliverUrlCallback(
          result,
          result.callback.url,
          options.fetchImpl,
        );
      }

      const nonce = newNonce();
      sendHtml(
        res,
        200,
        nonce,
        renderComplete({
          nonce,
          payload: {
            transaction: result.transaction,
            completion_token: result.completionToken,
          },
          callback: result.callback,
          ...(delivered !== undefined ? { urlCallbackDelivered: delivered } : {}),
        }),
        service.config.allowedCallbackOrigins,
      );
    } catch (err) {
      if (err instanceof Sep24Error && err.code === "VALIDATION_ERROR") {
        try {
          const session = await service.openSession(token);
          const nonce = newNonce();
          sendHtml(
            res,
            422,
            nonce,
            renderForm({
              nonce,
              token,
              session,
              values: form as FormValues,
              errors: err.fieldErrors ?? {},
              bannerError: "Please fix the highlighted fields.",
              ...(callback ? { callback } : {}),
            }),
            service.config.allowedCallbackOrigins,
          );
          return;
        } catch (inner) {
          sendError(res, service, inner);
          return;
        }
      }
      sendError(res, service, err);
    }
  });

  return router;
}

export const sep24InitiationRouter = createSep24InitiationRouter();
export const sep24InteractiveRouter = createSep24InteractiveRouter();
