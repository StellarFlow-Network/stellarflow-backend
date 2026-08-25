import { Router, Request, Response } from "express";
import Joi from "joi";
import { multiSigEnvelopeService } from "../services/multiSigEnvelopeService";
import { sendApiError } from "../lib/apiError.js";
import { logger } from "../utils/logger";

const router = Router();

/**
 * Schema for the multi-sig sign payload.
 * Used in: POST /api/v1/multisig/sign
 */
const multiSigSignSchema = Joi.object({
  envelopeXdr: Joi.string().required().messages({
    "any.required": "envelopeXdr is required",
    "string.base": "envelopeXdr must be a base64-encoded string",
  }),
  signerPublicKey: Joi.string()
    .pattern(/^G[A-Z2-7]{55}$/)
    .required()
    .messages({
      "any.required": "signerPublicKey is required",
      "string.pattern.base":
        "signerPublicKey must be a valid Stellar public key (G...)",
    }),
  signature: Joi.string().required().messages({
    "any.required": "signature is required",
    "string.base": "signature must be a base64-encoded string",
  }),
  requiredSignatures: Joi.number().integer().min(1).max(20).default(2),
}).unknown(false);

/**
 * POST /api/v1/multisig/sign
 * Collect a partial signature for a multi-sig administration transaction
 * envelope. Once the required signer threshold is reached, the fully signed
 * envelope is broadcast to Soroban RPC.
 */
router.post("/sign", async (req: Request, res: Response) => {
  try {
    const { error, value } = multiSigSignSchema.validate(req.body, {
      abortEarly: false,
      stripUnknown: false,
    });

    if (error) {
      logger.warn("[SECURITY] MultiSig sign validation failed", {
        error: error.message,
        ip: req.ip,
      });
      res.status(400).json({
        success: false,
        error: `Invalid request payload: ${error.message}`,
      });
      return;
    }

    const { envelopeXdr, signerPublicKey, signature, requiredSignatures } =
      value;

    const result = await multiSigEnvelopeService.collectSignature(
      envelopeXdr,
      signerPublicKey,
      signature,
      requiredSignatures,
    );

    res.json({
      success: true,
      data: result,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error("[API] MultiSig sign failed:", { error: message });
    sendApiError(res, 400, "INVALID_SIGNATURE", message);
  }
});

export default router;
