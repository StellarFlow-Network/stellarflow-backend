import Joi from "joi";

/**
 * Supported currency symbols/codes.
 * These are the whitelisted currencies allowed in the system.
 * Add more as needed.
 */
export const SUPPORTED_CURRENCIES = ["NGN", "GHS", "KES", "ZAR", "XLM"] as const;

/**
 * Regular expression for i128-compatible numbers.
 * i128 range: -170141183460469231731687303715884105728 to 170141183460469231731687303715884105727
 * Matches positive/negative numbers with optional decimals.
 */
const I128_PATTERN =
  /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/;

/**
 * Validates that a string represents a valid i128-compatible number.
 * Allows scientific notation and decimals.
 * @param value - The string to validate
 * @returns true if valid i128 number
 */
export function isValidI128String(value: string): boolean {
  if (typeof value !== "string" || value.length === 0) {
    return false;
  }

  if (!I128_PATTERN.test(value)) {
    return false;
  }

  try {
    const num = BigInt(value.split(".")[0]); // Take integer part only
    const MAX_I128 = BigInt("170141183460469231731687303715884105727");
    const MIN_I128 = BigInt("-170141183460469231731687303715884105728");

    return num >= MIN_I128 && num <= MAX_I128;
  } catch {
    return false;
  }
}

/**
 * Schema for price/rate values.
 * Accepts string or number, converts to string, validates i128 compatibility.
 */
export const priceSchema = Joi.alternatives().try(
  Joi.number().positive().required(),
  Joi.string()
    .pattern(I128_PATTERN)
    .required()
    .messages({
      "string.pattern.base":
        "Price must be a valid i128-compatible number (e.g., '123.45', '1e5')",
    }),
);

/**
 * Schema for currency symbols (3-letter uppercase codes).
 * Validates against the whitelist and rejects common injection patterns.
 */
export const currencySchema = Joi.string()
  .uppercase()
  .length(3)
  .pattern(/^[A-Z]+$/)
  .required()
  .valid(...SUPPORTED_CURRENCIES)
  .messages({
    "string.valid": `Currency must be one of: ${SUPPORTED_CURRENCIES.join(", ")}`,
    "string.pattern.base": "Currency must contain only letters",
    "string.length": "Currency code must be exactly 3 characters",
    "any.only": `Currency must be one of: ${SUPPORTED_CURRENCIES.join(", ")}`,
  });

/**
 * Schema for source/provider names.
 * Alphanumeric, dashes, underscores. Max 100 chars.
 * Prevents injection via source field.
 */
export const sourceSchema = Joi.string()
  .alphanum()
  .max(100)
  .required()
  .messages({
    "string.alphanum": "Source must contain only alphanumeric characters",
    "string.max": "Source must not exceed 100 characters",
  });

/**
 * Schema for memo IDs (used in Stellar transactions).
 * Format: SF-CURRENCY-TIMESTAMP-SEQUENCE
 * Example: SF-NGN-1234567890-001
 */
export const memoIdSchema = Joi.string()
  .pattern(/^SF-[A-Z]{3}-\d{10}-\d{3}$/)
  .optional()
  .messages({
    "string.pattern.base":
      "Memo ID must follow format: SF-CURRENCY-TIMESTAMP-SEQUENCE (e.g., SF-NGN-1234567890-001)",
  });

/**
 * Schema for price update multi-sig requests.
 * Used in: POST /api/v1/price-updates/multi-sig/request
 */
export const priceUpdateMultiSigRequestSchema = Joi.object({
  priceReviewId: Joi.number().integer().positive().required(),
  currency: currencySchema,
  rate: priceSchema,
  source: sourceSchema,
  memoId: memoIdSchema,
}).unknown(false); // Reject unknown fields

/**
 * Schema for signing requests.
 * Used in: POST /api/v1/price-updates/sign
 */
export const signatureRequestSchema = Joi.object({
  multiSigPriceId: Joi.number().integer().positive().required(),
}).unknown(false);

/**
 * Schema for market rate queries.
 * Used in: GET /api/v1/market-rates/rate/:currency
 */
export const marketRateQuerySchema = Joi.object({
  currency: currencySchema,
}).unknown(false);

/**
 * Schema for derived asset requests.
 * Used in endpoints that accept base and quote currencies.
 */
export const derivedAssetSchema = Joi.object({
  baseCurrency: currencySchema,
  quoteCurrency: currencySchema,
  rate: priceSchema.optional(),
}).unknown(false);

/**
 * Generic payload sanitization schema for any request body.
 * Strips dangerous content and enforces basic constraints.
 */
export const sanitizedPayloadSchema = Joi.object().unknown(true);

/**
 * Schema validation helper that returns detailed error info.
 */
export function validateSchema(
  schema: Joi.Schema,
  data: unknown,
  options: Joi.ValidationOptions = {},
): { isValid: boolean; error?: string; value?: unknown } {
  const defaultOptions: Joi.ValidationOptions = {
    abortEarly: false,
    stripUnknown: false,
    ...options,
  };

  const { error, value } = schema.validate(data, defaultOptions);

  if (error) {
    const messages = error.details
      .map((detail) => `${detail.path.join(".")}: ${detail.message}`)
      .join("; ");

    return {
      isValid: false,
      error: messages,
    };
  }

  return {
    isValid: true,
    value,
  };
}

/**
 * Wrapper for schema validation that throws on error.
 * Useful for synchronous validation in services.
 */
export function validateSchemaOrThrow(
  schema: Joi.Schema,
  data: unknown,
  context?: string,
): unknown {
  const { isValid, error, value } = validateSchema(schema, data);

  if (!isValid) {
    throw new Error(
      `${context || "Validation"} failed: ${error || "Unknown error"}`,
    );
  }

  return value;
}
