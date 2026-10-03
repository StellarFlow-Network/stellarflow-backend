/**
 * SEP-12 Customer Information Transfer (KYC) Routes – Issue #990
 *
 * Exposes the three SEP-12 customer endpoints:
 *
 *   GET    /api/v1/kyc/customer       – fetch a customer by id or account/memo
 *   PUT    /api/v1/kyc/customer       – create or update a customer
 *   DELETE /api/v1/kyc/customer/:id   – delete a customer
 *
 * Configuration
 * -------------
 * KYC_ENCRYPTION_KEY  – AES-256-GCM master key for the KYC payload store
 *                       (falls back to VAULT_MASTER_KEY)
 * KYC_ANCHOR_URL      – optional remittance anchor endpoint that receives the
 *                       encrypted KYC payload. When unset the customer is kept
 *                       in PROCESSING locally and no network call is made.
 *
 * Responses follow the SEP-12 wire format. Errors use the repository's
 * `sendApiError` envelope so failures stay consistent with the rest of the API.
 */

import { Router, type Request, type Response } from "express";
import { sendApiError } from "../lib/apiError.js";
import { kycService } from "../services/kyc";
import { KycService } from "../services/kycService";
import {
  KycAnchorError,
} from "../services/kycAnchorClient";
import { KycEncryptionError } from "../services/kycEncryption";
import {
  Sep12NotFoundError,
  Sep12TransitionError,
  Sep12ValidationError,
  parseMemoType,
  type GetCustomerParams,
} from "../services/kycTypes";

/** The subset of `KycService` the HTTP layer depends on. */
export type KycRouterService = Pick<
  KycService,
  "getCustomer" | "putCustomer" | "deleteCustomer"
>;

/** Collapse Express query values (which may be arrays) to a single string. */
function queryValue(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (Array.isArray(value) && typeof value[0] === "string") return value[0];
  return undefined;
}

function sendServiceError(res: Response, error: unknown): void {
  if (error instanceof Sep12ValidationError) {
    sendApiError(res, 400, "VALIDATION_ERROR", error.message);
    return;
  }
  if (error instanceof Sep12NotFoundError) {
    sendApiError(res, 404, "NOT_FOUND", error.message);
    return;
  }
  if (error instanceof Sep12TransitionError) {
    sendApiError(res, 409, "CONFLICT", error.message);
    return;
  }
  if (error instanceof KycAnchorError) {
    sendApiError(res, 502, "ANCHOR_UNAVAILABLE", error.message);
    return;
  }
  if (error instanceof KycEncryptionError) {
    sendApiError(res, 500, "INTERNAL_SERVER_ERROR", error.message);
    return;
  }
  sendApiError(
    res,
    500,
    "INTERNAL_SERVER_ERROR",
    error instanceof Error ? error.message : "Failed to process the customer",
  );
}

export function createKycRouter(
  service: KycRouterService = kycService,
): Router {
  const router = Router();

  /**
   * @swagger
   * /api/v1/kyc/customer:
   *   get:
   *     tags: [KYC]
   *     summary: Retrieve a SEP-12 customer
   *     description: >
   *       Looks a customer up by server-assigned `id`, or by `account` with an
   *       optional `memo`/`memo_type`. Returns the SEP-12 customer object,
   *       including the KYC fields previously supplied.
   *     parameters:
   *       - in: query
   *         name: id
   *         schema: { type: string }
   *       - in: query
   *         name: account
   *         schema: { type: string }
   *       - in: query
   *         name: memo
   *         schema: { type: string }
   *       - in: query
   *         name: memo_type
   *         schema: { type: string, enum: [id, text, hash] }
   *     responses:
   *       '200': { description: The SEP-12 customer object }
   *       '400': { description: Invalid or missing identity parameters }
   *       '404': { description: Customer not found }
   */
  router.get("/customer", async (req: Request, res: Response) => {
    try {
      const params: GetCustomerParams = {
        id: queryValue(req.query.id),
        account: queryValue(req.query.account),
        memo: queryValue(req.query.memo),
        memoType: parseMemoType(queryValue(req.query.memo_type)),
      };

      const customer = await service.getCustomer(params);
      if (!customer) {
        sendApiError(res, 404, "NOT_FOUND", "Customer not found");
        return;
      }

      res.status(200).json(customer);
    } catch (error) {
      sendServiceError(res, error);
    }
  });

  /**
   * @swagger
   * /api/v1/kyc/customer:
   *   put:
   *     tags: [KYC]
   *     summary: Create or update a SEP-12 customer
   *     description: >
   *       Creates the customer when the identity is unknown, otherwise updates
   *       the existing record. The KYC fields are encrypted at rest and the
   *       encrypted payload is forwarded to the configured anchor. Returns the
   *       SEP-12 `{ id, status, message?, fields? }` envelope.
   *     responses:
   *       '200': { description: Customer created or updated }
   *       '400': { description: Validation error }
   *       '404': { description: Unknown customer id }
   */
  router.put("/customer", async (req: Request, res: Response) => {
    try {
      const result = await service.putCustomer(req.body);
      res.status(200).json(result);
    } catch (error) {
      sendServiceError(res, error);
    }
  });

  /**
   * @swagger
   * /api/v1/kyc/customer/{id}:
   *   delete:
   *     tags: [KYC]
   *     summary: Delete a SEP-12 customer
   *     parameters:
   *       - in: path
   *         name: id
   *         required: true
   *         schema: { type: string }
   *     responses:
   *       '200': { description: Customer deleted }
   *       '404': { description: Customer not found }
   */
  router.delete("/customer/:id", async (req: Request, res: Response) => {
    try {
      const deleted = await service.deleteCustomer(req.params.id ?? "");
      if (!deleted) {
        sendApiError(res, 404, "NOT_FOUND", "Customer not found");
        return;
      }
      res.status(200).json({});
    } catch (error) {
      sendServiceError(res, error);
    }
  });

  return router;
}

export default createKycRouter();
