import { Request, Response, NextFunction } from "express";
import Joi from "joi";
import { logger } from "../utils/logger";
import {
  validateSchema,
  priceUpdateMultiSigRequestSchema,
  signatureRequestSchema,
  marketRateQuerySchema,
  sanitizedPayloadSchema,
} from "./validationSchemas";

/**
 * Request payload sanitization middleware.
 *
 * Purpose:
 * - Prevent injection attacks through malformed request bodies
 * - Enforce strict data type validation (e.g., i128-compatible prices)
 * - Validate against business whitelist (e.g., supported currencies)
 * - Normalize data (e.g., uppercase currency codes)
 * - Block requests with unknown/suspicious fields by route
 *
 * Features:
 * - Logs validation errors for security monitoring
 * - Returns clear error messages to clients
 * - Gracefully handles edge cases (null, undefined, wrong types)
 */

/**
 * Generic payload sanitizer with schema validation.
 * Returns middleware that uses the provided Joi schema.
 *
 * @param schema - Joi schema to validate against
 * @param name - Name of the validation (for logging)
 * @param stripUnknown - Whether to remove unknown fields
 * @returns Express middleware function
 */
export function createPayloadSanitizer(
  schema: Joi.Schema,
  name: string = "payload",
  stripUnknown: boolean = false,
): (req: Request, res: Response, next: NextFunction) => void {
  return (req: Request, res: Response, next: NextFunction): void => {
    try {
      // Validate the request body against schema
      const { isValid, error, value } = validateSchema(schema, req.body, {
        stripUnknown,
        abortEarly: false,
      });

      if (!isValid) {
        logger.warn(`[SECURITY] ${name} validation failed`, {
          error,
          ip: req.ip,
          route: req.path,
          timestamp: new Date().toISOString(),
        });

        res.status(400).json({
          success: false,
          error: `Invalid request payload: ${error}`,
          details: `${name} validation failed`,
        });
        return;
      }

      // Replace body with sanitized version
      req.body = value;
      next();
    } catch (err) {
      logger.error(`[SECURITY] ${name} sanitization error`, {
        error: err instanceof Error ? err.message : String(err),
        ip: req.ip,
        route: req.path,
      });

      res.status(500).json({
        success: false,
        error: "Request validation error",
      });
    }
  };
}

/**
 * Multi-sig price update request sanitizer.
 * Validates: priceReviewId, currency, rate, source, memoId
 *
 * Usage:
 * router.post("/multi-sig/request", sanitizeMultiSigRequest, handler);
 */
export const sanitizeMultiSigRequest = createPayloadSanitizer(
  priceUpdateMultiSigRequestSchema,
  "MultiSigRequest",
  false,
);

/**
 * Signature request sanitizer.
 * Validates: multiSigPriceId
 *
 * Usage:
 * router.post("/sign", sanitizeSignatureRequest, handler);
 */
export const sanitizeSignatureRequest = createPayloadSanitizer(
  signatureRequestSchema,
  "SignatureRequest",
  false,
);

/**
 * Market rate query sanitizer (for GET request query params).
 * Converts query params to a body-like object for validation.
 *
 * Usage:
 * router.get("/rate/:currency", sanitizeMarketRateQuery, handler);
 */
export function sanitizeMarketRateQuery(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  try {
    // Convert URL param to schema format
    const dataToValidate = {
      currency: req.params.currency,
    };

    const { isValid, error, value } = validateSchema(
      marketRateQuerySchema,
      dataToValidate,
      { stripUnknown: false },
    );

    if (!isValid) {
      logger.warn("[SECURITY] Market rate query validation failed", {
        error,
        ip: req.ip,
        currency: req.params.currency,
      });

      res.status(400).json({
        success: false,
        error: `Invalid currency parameter: ${error}`,
      });
      return;
    }

    // Store sanitized values back in params
    req.params = value as any;
    next();
  } catch (err) {
    logger.error("[SECURITY] Market rate query sanitization error", {
      error: err instanceof Error ? err.message : String(err),
      ip: req.ip,
    });

    res.status(500).json({
      success: false,
      error: "Query validation error",
    });
  }
}

/**
 * Generic request body sanitizer with no schema.
 * Removes potentially dangerous fields from any JSON body.
 *
 * Usage:
 * router.use(sanitizeGenericPayload);
 */
export function sanitizeGenericPayload(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  try {
    if (!req.body || typeof req.body !== "object") {
      next();
      return;
    }

    // List of potentially dangerous field names to reject
    const dangerousFields = [
      "__proto__",
      "constructor",
      "prototype",
      "eval",
      "exec",
      "system",
      "shell",
    ];

    const sanitized = { ...req.body };

    // Remove dangerous fields
    dangerousFields.forEach((field) => {
      delete sanitized[field];
    });

    // Check for suspicious patterns in all string values
    const hasSuspiciousContent = Object.values(sanitized).some(
      (val) =>
        typeof val === "string" &&
        (/(<|>|eval|exec|script)/i.test(val) ||
          /['"`;]/g.test(val)),
    );

    if (hasSuspiciousContent) {
      logger.warn("[SECURITY] Suspicious content detected in payload", {
        ip: req.ip,
        route: req.path,
        timestamp: new Date().toISOString(),
      });
    }

    req.body = sanitized;
    next();
  } catch (err) {
    logger.error("[SECURITY] Generic payload sanitization error", {
      error: err instanceof Error ? err.message : String(err),
    });
    next(); // Continue anyway
  }
}

/**
 * Middleware factory for validating price and currency in the same request.
 * Used for endpoints that accept both price and currency/symbol.
 *
 * @param priceField - The field name containing the price (default: 'rate')
 * @param currencyField - The field name containing currency (default: 'currency')
 * @returns Express middleware
 */
export function validatePriceAndCurrency(
  priceField: string = "rate",
  currencyField: string = "currency",
): (req: Request, res: Response, next: NextFunction) => void {
  return (req: Request, res: Response, next: NextFunction): void => {
    try {
      const price = req.body[priceField];
      const currency = req.body[currencyField];

      // Validate price is numeric and positive
      const priceNum =
        typeof price === "string" ? parseFloat(price) : price;
      if (!Number.isFinite(priceNum) || priceNum <= 0) {
        res.status(400).json({
          success: false,
          error: `${priceField} must be a positive number`,
        });
        return;
      }

      // Validate currency is 3-letter uppercase
      if (
        typeof currency !== "string" ||
        currency.length !== 3 ||
        !/^[A-Z]+$/.test(currency)
      ) {
        res.status(400).json({
          success: false,
          error: `${currencyField} must be a 3-letter uppercase code`,
        });
        return;
      }

      // Normalize: uppercase currency
      req.body[currencyField] = currency.toUpperCase();

      next();
    } catch (err) {
      logger.error("[SECURITY] Price/currency validation error", {
        error: err instanceof Error ? err.message : String(err),
      });

      res.status(500).json({
        success: false,
        error: "Validation error",
      });
    }
  };
}

/**
 * Middleware to log all incoming payloads for security audit trails.
 * Masks sensitive fields before logging.
 *
 * Usage:
 * app.use(logPayload);
 */
export function logPayload(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  try {
    // Fields to mask in logs
    const sensitiveFields = [
      "secret",
      "password",
      "token",
      "apiKey",
      "authorization",
    ];

    const sanitizedBody = { ...req.body };
    sensitiveFields.forEach((field) => {
      if (field in sanitizedBody) {
        sanitizedBody[field] = "***REDACTED***";
      }
    });

    logger.info("[API] Incoming request", {
      method: req.method,
      path: req.path,
      ip: req.ip,
      body: sanitizedBody,
      timestamp: new Date().toISOString(),
    });

    next();
  } catch (err) {
    // Don't block requests if logging fails
    next();
  }
}
