import helmet from "helmet";
import type { RequestHandler } from "express";

import type { EnvSource } from "../types/env.types";

/**
 * Security HTTP header injection (Issue #792).
 *
 * The API serves JSON, so it gets a `default-src 'none'` policy that permits no
 * subresource loading and no framing at all. Swagger UI is the one HTML surface
 * in the app and needs a looser policy, so it is matched by path and handled
 * separately instead of relaxing the policy globally.
 */

const DOCS_PATH_PREFIX = "/api/v1/docs";

const DEFAULT_HSTS_MAX_AGE_SECONDS = 31_536_000; // 1 year

/**
 * Denies every fetch directive by default. `frame-ancestors 'none'` is the
 * modern equivalent of X-Frame-Options: DENY, which is still sent alongside it
 * for older browsers.
 */
const API_CSP_DIRECTIVES: Record<string, string[]> = {
  "default-src": ["'none'"],
  "base-uri": ["'none'"],
  "form-action": ["'none'"],
  "frame-ancestors": ["'none'"],
  "object-src": ["'none'"],
};

/** Swagger UI bundles inline scripts and styles and inlines its icons as data URIs. */
const DOCS_CSP_DIRECTIVES: Record<string, string[]> = {
  "default-src": ["'self'"],
  "base-uri": ["'self'"],
  "form-action": ["'self'"],
  "frame-ancestors": ["'none'"],
  "object-src": ["'none'"],
  "script-src": ["'self'", "'unsafe-inline'"],
  "style-src": ["'self'", "'unsafe-inline'"],
  "img-src": ["'self'", "data:"],
  "font-src": ["'self'", "data:"],
  "connect-src": ["'self'"],
};

/**
 * Browser features the API never needs. Sent explicitly because helmet does not
 * set Permissions-Policy.
 */
const PERMISSIONS_POLICY = [
  "accelerometer=()",
  "ambient-light-sensor=()",
  "autoplay=()",
  "camera=()",
  "display-capture=()",
  "encrypted-media=()",
  "fullscreen=()",
  "geolocation=()",
  "gyroscope=()",
  "magnetometer=()",
  "microphone=()",
  "midi=()",
  "payment=()",
  "picture-in-picture=()",
  "publickey-credentials-get=()",
  "screen-wake-lock=()",
  "usb=()",
  "xr-spatial-tracking=()",
].join(", ");

function parseBoolean(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  return value === "true";
}

function resolveHstsOptions(env: EnvSource) {
  const maxAge = Number.parseInt(env.HSTS_MAX_AGE_SECONDS ?? "", 10);

  return {
    maxAge: Number.isFinite(maxAge) ? maxAge : DEFAULT_HSTS_MAX_AGE_SECONDS,
    includeSubDomains: parseBoolean(env.HSTS_INCLUDE_SUBDOMAINS, false),
    preload: parseBoolean(env.HSTS_PRELOAD, false),
  };
}

/**
 * Builds the CSP directive set, appending `report-uri` when configured so
 * violations can be collected during a report-only rollout.
 */
export function buildCspDirectives(
  base: Record<string, string[]>,
  env: EnvSource = process.env,
): Record<string, string[]> {
  const reportUri = env.CSP_REPORT_URI?.trim();
  if (!reportUri) return base;

  return { ...base, "report-uri": [reportUri] };
}

function buildHelmet(
  directives: Record<string, string[]>,
  env: EnvSource,
): RequestHandler {
  return helmet({
    contentSecurityPolicy: {
      useDefaults: false,
      directives: buildCspDirectives(directives, env),
      reportOnly: parseBoolean(env.CSP_REPORT_ONLY, false),
    },
    // X-Frame-Options: DENY — legacy counterpart to frame-ancestors 'none'.
    frameguard: { action: "deny" },
    // X-Content-Type-Options: nosniff
    noSniff: true,
    referrerPolicy: { policy: "strict-origin-when-cross-origin" },
    hsts: resolveHstsOptions(env),
    crossOriginOpenerPolicy: { policy: "same-origin" },
    // Blocks no-cors embedding of API responses as images/scripts. Does not
    // affect the CORS-preflighted fetches the dashboard makes.
    crossOriginResourcePolicy: { policy: "same-origin" },
    hidePoweredBy: true,
    // Superseded by CSP in every supported browser and known to break some
    // legitimate payloads when enabled.
    xssFilter: false,
  });
}

let cachedApiHelmet: RequestHandler | null = null;
let cachedDocsHelmet: RequestHandler | null = null;

/**
 * Injects the security header set on every response, choosing the strict API
 * policy or the Swagger UI policy based on the request path.
 *
 * Handlers are built on first request because modules are imported before
 * `dotenv.config()` runs in the app entrypoint.
 */
export const securityHeadersMiddleware: RequestHandler = (req, res, next) => {
  if (!cachedApiHelmet || !cachedDocsHelmet) {
    cachedApiHelmet = buildHelmet(API_CSP_DIRECTIVES, process.env);
    cachedDocsHelmet = buildHelmet(DOCS_CSP_DIRECTIVES, process.env);
  }

  res.setHeader("Permissions-Policy", PERMISSIONS_POLICY);
  res.setHeader("X-Permitted-Cross-Domain-Policies", "none");

  const handler = req.path.startsWith(DOCS_PATH_PREFIX)
    ? cachedDocsHelmet
    : cachedApiHelmet;

  handler(req, res, next);
};

/** Rebuilds the header handlers from the current environment. Used by tests. */
export function refreshSecurityHeaders(): void {
  cachedApiHelmet = null;
  cachedDocsHelmet = null;
}

export const securityHeaderPolicies = {
  api: API_CSP_DIRECTIVES,
  docs: DOCS_CSP_DIRECTIVES,
  permissionsPolicy: PERMISSIONS_POLICY,
};

export default securityHeadersMiddleware;
