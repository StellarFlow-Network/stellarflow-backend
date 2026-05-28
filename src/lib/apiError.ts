import type { Response } from "express";

/**
 * Base URL for the internal error wiki. Override with INTERNAL_WIKI_BASE_URL.
 * Paths are appended as /Errors/<errorCode>.
 */
export const WIKI_BASE_URL = (
  process.env.INTERNAL_WIKI_BASE_URL ??
  "https://github.com/morapay-app/stellarflow-backend/wiki"
).replace(/\/$/, "");

export interface ApiErrorPayload {
  success: false;
  error: string;
  errorCode: string;
  helpLink: string;
}

/** Default human-readable messages for stable error codes. */
export const ERROR_MESSAGES: Record<string, string> = {
  BAD_REQUEST: "The request could not be processed.",
  VALIDATION_ERROR: "One or more request fields are invalid.",
  UNAUTHORIZED: "Authentication is required.",
  FORBIDDEN: "You do not have permission to perform this action.",
  NOT_FOUND: "The requested resource was not found.",
  METHOD_NOT_ALLOWED: "This HTTP method is not allowed for the endpoint.",
  CONFLICT: "The request conflicts with the current state.",
  RATE_LIMITED: "Too many requests. Please try again later.",
  INTERNAL_SERVER_ERROR: "An unexpected error occurred.",
  SERVICE_UNAVAILABLE: "The service is temporarily unavailable.",
  MAINTENANCE_MODE: "Service is under maintenance. Please try again later.",
  MISSING_API_KEY: "Request must include a valid X-API-Key header.",
  INVALID_API_KEY: "The provided API key is invalid or inactive.",
  INSUFFICIENT_SCOPE: "This API key does not have the required scope.",
  EXPIRED_API_KEY: "The provided API key has expired.",
  INVALID_TOKEN: "The bearer token is invalid or expired.",
  MISSING_TOKEN: "Authorization bearer token is required.",
  INVALID_SIGNATURE: "Request signature verification failed.",
  STALE_PAYLOAD: "The submitted payload is too old to accept.",
  LOCKDOWN_ACTIVE: "The system is in lockdown; writes are disabled.",
  CURRENCY_REQUIRED: "Currency parameter is required.",
  CURRENCY_NOT_FOUND: "No rate is available for the requested currency.",
  ASSET_NOT_FOUND: "The requested asset was not found.",
  PRICE_NOT_FOUND: "No recent price was found for comparison.",
  EXTERNAL_PRICE_UNAVAILABLE:
    "Unable to fetch an external price for comparison.",
  ENDPOINT_NOT_FOUND: "Endpoint not found",
  CORS_DENIED: "Cross-origin request denied by CORS policy.",
  PAYLOAD_TOO_LARGE: "Request body exceeds the allowed size.",
  INVALID_JSON: "Request body must be valid JSON.",
  API_KEY_INACTIVE: "This API key has been revoked.",
  API_KEY_EXPIRED: "This API key has expired.",
  UNAUTHENTICATED: "Authentication middleware must run before this handler.",
  INVALID_ADMIN_KEY: "Invalid or missing admin API key.",
  ADMIN_IP_DENIED: "Admin access denied for this IP address.",
};

export function buildHelpLink(errorCode: string): string {
  const slug = encodeURIComponent(errorCode);
  return `${WIKI_BASE_URL}/Errors/${slug}`;
}

export function apiErrorPayload(
  errorCode: string,
  message?: string,
): ApiErrorPayload {
  const resolvedMessage =
    message?.trim() ||
    ERROR_MESSAGES[errorCode] ||
    ERROR_MESSAGES.INTERNAL_SERVER_ERROR;

  return {
    success: false,
    error: resolvedMessage,
    errorCode,
    helpLink: buildHelpLink(errorCode),
  };
}

export function sendApiError(
  res: Response,
  status: number,
  errorCode: string,
  message?: string,
): void {
  res.status(status).json(apiErrorPayload(errorCode, message));
}

/** Map common HTTP statuses to default error codes when only a message is known. */
export function errorCodeForStatus(status: number): string {
  switch (status) {
    case 400:
      return "BAD_REQUEST";
    case 401:
      return "UNAUTHORIZED";
    case 403:
      return "FORBIDDEN";
    case 404:
      return "NOT_FOUND";
    case 409:
      return "CONFLICT";
    case 429:
      return "RATE_LIMITED";
    case 503:
      return "SERVICE_UNAVAILABLE";
    default:
      return "INTERNAL_SERVER_ERROR";
  }
}
