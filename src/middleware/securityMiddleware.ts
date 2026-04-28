import { Request, Response, NextFunction } from "express";
import { logger } from "../utils/logger";

// Regexes to detect SQLi and XSS-like patterns (including common encoded forms)
const suspiciousPattern = /(<script\b|<\/script>|onerror=|onload=|javascript:)|\b(select|union|insert|update|delete|drop|alter|create|exec)\b|['"`;--]|%27|%3C|%3E|%3B/i;
const strictParamPattern = /[<>{}"'`;\-\-]|%27|%3C|%3E|%3B/;

/**
 * Middleware that inspects request headers for common attack patterns
 * (SQL injection, XSS). Logs and blocks requests with suspicious headers.
 */
export function inspectHeadersMiddleware(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  try {
    const headers = req.headers;

    for (const [name, value] of Object.entries(headers)) {
      if (!value) continue;

      const values = Array.isArray(value) ? value : [String(value)];

      for (const v of values) {
        if (suspiciousPattern.test(v)) {
          logger.warn("[SECURITY] Suspicious header detected", {
            header: name,
            value: typeof v === "string" && v.length > 200 ? `${v.slice(0, 200)}...` : v,
            ip: req.ip,
            path: req.path,
          });

          res.status(400).json({
            success: false,
            error: `Suspicious header content detected: ${name}`,
          });
          return;
        }
      }
    }

    next();
  } catch (err) {
    logger.error("[SECURITY] Header inspection error", {
      error: err instanceof Error ? err.message : String(err),
    });
    next();
  }
}

type StrictOptions = {
  /** If true the middleware is always active. Otherwise it can be enabled by header or env. */
  enabled?: boolean;
  /** Header name that can toggle strict mode per-request. Default: 'x-strict-mode' */
  toggleHeader?: string;
};

/**
 * Creates a Strict Mode middleware that blocks requests containing suspicious
 * characters in `symbol` or `provider` query parameters.
 *
 * Strict Mode is enabled when:
 * - options.enabled === true, OR
 * - process.env.STRICT_MODE === 'true', OR
 * - the request contains header named options.toggleHeader with value 'true'
 */
export function createStrictModeMiddleware(options: StrictOptions = {}) {
  const toggleHeader = options.toggleHeader || "x-strict-mode";

  return (req: Request, res: Response, next: NextFunction): void => {
    try {
      const envEnabled = process.env.STRICT_MODE === "true";
      const headerEnabled = String(req.headers[toggleHeader] || "").toLowerCase() === "true";
      const enabled = Boolean(options.enabled) || envEnabled || headerEnabled;

      if (!enabled) {
        next();
        return;
      }

      const check = (val: any): boolean => {
        if (val == null) return false;
        if (Array.isArray(val)) val = val[0];
        if (typeof val !== "string") val = String(val);
        // trim and check for suspicious characters or encoded equivalents
        return strictParamPattern.test(val) || /\b(or|and)\b\s+\d+=\d+/i.test(val);
      };

      const { symbol, provider } = req.query as Record<string, any>;

      if (check(symbol) || check(provider)) {
        logger.warn("[SECURITY] Strict Mode blocked suspicious query params", {
          ip: req.ip,
          path: req.path,
          symbol,
          provider,
        });

        res.status(400).json({
          success: false,
          error: "Strict Mode: suspicious characters in query parameters",
        });
        return;
      }

      next();
    } catch (err) {
      logger.error("[SECURITY] Strict Mode middleware error", {
        error: err instanceof Error ? err.message : String(err),
      });
      next();
    }
  };
}

export default {
  inspectHeadersMiddleware,
  createStrictModeMiddleware,
};
