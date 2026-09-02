import cors from "cors";
import type { CorsOptions } from "cors";
import type { Request, Response, NextFunction, RequestHandler } from "express";

import { sendApiError } from "../lib/apiError.js";
import type { EnvSource } from "../types/env.types";
import { logger } from "../utils/logger";

/**
 * Strict CORS whitelist policy for approved web and mobile clients (Issue #792).
 *
 * CORS is enforced by the browser, not the server: a disallowed origin still
 * reaches the handler for simple requests. `originGuard` therefore complements
 * this by rejecting such requests server-side before they touch business logic.
 */

/** Origins that are matched literally, plus single-label wildcards like `https://*.example.com`. */
const DEFAULT_DEV_ORIGIN = "http://localhost:3000";

const DEFAULT_ALLOWED_METHODS = [
  "GET",
  "HEAD",
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
  "OPTIONS",
];

/**
 * Request headers the API actually consumes. Anything outside this list is
 * rejected at preflight rather than silently ignored.
 */
const DEFAULT_ALLOWED_HEADERS = [
  "Accept",
  "Authorization",
  "Content-Type",
  "Origin",
  "X-Requested-With",
  "X-API-Key",
  "X-Admin-Key",
  "X-Stellar-Signature",
  "X-Stellar-Timestamp",
  "X-Strict-Mode",
];

const DEFAULT_EXPOSED_HEADERS = [
  "RateLimit-Limit",
  "RateLimit-Remaining",
  "RateLimit-Reset",
  "Retry-After",
];

const DEFAULT_MAX_AGE_SECONDS = 600;

/**
 * Headers that identify a non-browser client (relayer, mobile SDK, service).
 * Their presence is what allows an Origin-less request through the guard; the
 * value itself is still validated downstream by the API key / signature layers.
 */
const NON_BROWSER_CREDENTIAL_HEADERS = ["x-api-key", "x-stellar-signature"];

/** Paths that must stay reachable without an Origin (probes, docs, metrics). */
const ORIGIN_GUARD_EXEMPT_PATHS = [
  "/health",
  "/metrics",
  "/api/v1/docs",
  "/api/v1/status",
];

export type OriginEnforcementMode = "enforce" | "report-only";

/** Thrown by the CORS origin callback so `corsErrorHandler` can map it to a 403. */
export class CorsOriginError extends Error {
  readonly code = "CORS_DENIED";
  readonly origin: string;

  constructor(origin: string) {
    super(`Origin ${origin} is not in the CORS allowlist`);
    this.name = "CorsOriginError";
    this.origin = origin;
  }
}

/**
 * Normalizes an origin for comparison: trims, drops trailing slashes and
 * lowercases. Origins carry no path, so lowercasing is lossless. Non-HTTP
 * schemes used by mobile webviews (`capacitor://`, `ionic://`) survive intact.
 */
export function normalizeOrigin(value: unknown): string | null {
  if (typeof value !== "string") return null;

  const trimmed = value.trim().replace(/\/+$/, "").toLowerCase();
  return trimmed.length > 0 ? trimmed : null;
}

/** Parses a comma-separated allowlist, rejecting the catch-all `*`. */
export function parseAllowedOrigins(raw: string | undefined): string[] {
  if (!raw) return [];

  const origins = new Set<string>();

  for (const candidate of raw.split(",")) {
    const normalized = normalizeOrigin(candidate);
    if (!normalized) continue;

    if (normalized === "*") {
      logger.warn(
        "[CORS] Ignoring wildcard '*' in CORS_ALLOWED_ORIGINS; the policy requires an explicit allowlist",
      );
      continue;
    }

    if ((normalized.match(/\*/g) ?? []).length > 1) {
      logger.warn(
        `[CORS] Ignoring malformed allowlist entry '${normalized}': at most one wildcard is supported`,
      );
      continue;
    }

    origins.add(normalized);
  }

  return [...origins];
}

/**
 * Matches a single-label wildcard pattern, so `https://*.example.com` matches
 * `https://app.example.com` but not `https://a.b.example.com` (which would
 * widen the policy to nested subdomains an attacker may control).
 */
function matchesWildcard(candidate: string, pattern: string): boolean {
  const starIndex = pattern.indexOf("*");
  const prefix = pattern.slice(0, starIndex);
  const suffix = pattern.slice(starIndex + 1);

  if (candidate.length < prefix.length + suffix.length) return false;
  if (!candidate.startsWith(prefix)) return false;
  if (suffix.length > 0 && !candidate.endsWith(suffix)) return false;

  const label = candidate.slice(
    prefix.length,
    candidate.length - suffix.length,
  );
  return label.length > 0 && !label.includes(".") && !label.includes("/");
}

export function isOriginAllowed(
  origin: unknown,
  allowlist: readonly string[],
): boolean {
  const candidate = normalizeOrigin(origin);
  if (!candidate) return false;

  return allowlist.some((entry) =>
    entry.includes("*")
      ? matchesWildcard(candidate, entry)
      : entry === candidate,
  );
}

/**
 * Resolves the allowlist from `CORS_ALLOWED_ORIGINS`, falling back to the
 * legacy single-origin `DASHBOARD_URL` / `FRONTEND_URL` variables so existing
 * deployments keep working. Production with no configuration denies everything
 * rather than quietly opening up to localhost.
 */
export function resolveAllowedOrigins(env: EnvSource = process.env): string[] {
  const explicit = parseAllowedOrigins(env.CORS_ALLOWED_ORIGINS);
  if (explicit.length > 0) return explicit;

  const legacy = parseAllowedOrigins(
    [env.DASHBOARD_URL, env.FRONTEND_URL].filter(Boolean).join(","),
  );
  if (legacy.length > 0) return legacy;

  if (env.NODE_ENV === "production") {
    logger.error(
      "[CORS] No allowed origins configured. Set CORS_ALLOWED_ORIGINS; all cross-origin requests will be denied.",
    );
    return [];
  }

  return [DEFAULT_DEV_ORIGIN];
}

let cachedAllowedOrigins: string[] | null = null;
let cachedCorsHandler: RequestHandler | null = null;

export function getAllowedOrigins(): string[] {
  if (!cachedAllowedOrigins) {
    cachedAllowedOrigins = resolveAllowedOrigins();
    logger.info(
      `[CORS] Allowlist loaded (${cachedAllowedOrigins.length} origin(s)): ${
        cachedAllowedOrigins.join(", ") || "none"
      }`,
    );
  }

  return cachedAllowedOrigins;
}

/** Re-reads the allowlist from the environment. Used by the env watcher and tests. */
export function refreshAllowedOrigins(): string[] {
  cachedAllowedOrigins = null;
  cachedCorsHandler = null;
  return getAllowedOrigins();
}

export function getOriginEnforcementMode(
  env: EnvSource = process.env,
): OriginEnforcementMode {
  return env.CORS_ORIGIN_ENFORCEMENT === "report-only"
    ? "report-only"
    : "enforce";
}

function parseHeaderList(
  raw: string | undefined,
  fallback: string[],
): string[] {
  if (!raw) return fallback;

  const values = raw
    .split(",")
    .map((value) => value.trim())
    .filter((value) => value.length > 0);

  return values.length > 0 ? values : fallback;
}

export function buildCorsOptions(env: EnvSource = process.env): CorsOptions {
  const maxAge = Number.parseInt(env.CORS_MAX_AGE_SECONDS ?? "", 10);

  return {
    origin(origin, callback) {
      // No Origin header means this is not a browser CORS request, so there is
      // nothing to echo back. `originGuard` decides whether to allow it.
      if (origin === undefined) {
        callback(null, false);
        return;
      }

      if (isOriginAllowed(origin, getAllowedOrigins())) {
        callback(null, true);
        return;
      }

      callback(new CorsOriginError(origin));
    },
    credentials: env.CORS_ALLOW_CREDENTIALS !== "false",
    methods: parseHeaderList(env.CORS_ALLOWED_METHODS, DEFAULT_ALLOWED_METHODS),
    allowedHeaders: parseHeaderList(
      env.CORS_ALLOWED_HEADERS,
      DEFAULT_ALLOWED_HEADERS,
    ),
    exposedHeaders: parseHeaderList(
      env.CORS_EXPOSED_HEADERS,
      DEFAULT_EXPOSED_HEADERS,
    ),
    maxAge: Number.isFinite(maxAge) ? maxAge : DEFAULT_MAX_AGE_SECONDS,
    optionsSuccessStatus: 204,
  };
}

/**
 * Options are resolved on first request rather than at import time, because
 * modules are imported before `dotenv.config()` runs in the app entrypoint.
 */
export const corsMiddleware: RequestHandler = (req, res, next) => {
  if (!cachedCorsHandler) {
    cachedCorsHandler = cors(buildCorsOptions());
  }

  cachedCorsHandler(req, res, next);
};

/**
 * Converts a rejected origin into a 403 CORS_DENIED response. Without this the
 * error reaches the generic handler and surfaces as a misleading 500.
 *
 * Must be registered immediately after `corsMiddleware`.
 */
export function corsErrorHandler(
  err: unknown,
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  if (!(err instanceof CorsOriginError)) {
    next(err);
    return;
  }

  logger.warn("[CORS] Blocked request from disallowed origin", {
    origin: err.origin,
    method: req.method,
    path: req.path,
    ip: req.ip,
  });

  sendApiError(
    res,
    403,
    "CORS_DENIED",
    `Origin '${err.origin}' is not permitted to access this API.`,
  );
}

/**
 * Express rewrites `req.path` relative to the mount point, so the mount prefix
 * has to be added back to compare against absolute exemption paths.
 */
function resolveFullPath(req: Request): string {
  return `${req.baseUrl ?? ""}${req.path}`;
}

export function isExemptFromOriginGuard(path: string): boolean {
  return ORIGIN_GUARD_EXEMPT_PATHS.some(
    (exempt) => path === exempt || path.startsWith(`${exempt}/`),
  );
}

function hasNonBrowserCredential(req: Request): boolean {
  return NON_BROWSER_CREDENTIAL_HEADERS.some((header) => {
    const value = req.headers[header];
    return typeof value === "string" && value.trim().length > 0;
  });
}

/** Derives the origin of a Referer URL, for browsers that omit Origin on same-site GETs. */
function originFromReferer(referer: unknown): string | null {
  if (typeof referer !== "string" || referer.trim().length === 0) return null;

  try {
    return normalizeOrigin(new URL(referer).origin);
  } catch {
    return null;
  }
}

/**
 * Blocks unauthorized API requests that are missing a usable Origin header.
 *
 * A request passes when it either carries an allowlisted Origin (or Referer),
 * or identifies itself as a non-browser client via `X-API-Key` /
 * `X-Stellar-Signature`. Native mobile apps, relayers and service-to-service
 * callers take the latter path.
 *
 * Register before the authentication middleware so rejected traffic never
 * reaches a database lookup.
 */
export function originGuard(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  if (
    req.method === "OPTIONS" ||
    isExemptFromOriginGuard(resolveFullPath(req))
  ) {
    next();
    return;
  }

  const allowlist = getAllowedOrigins();
  const origin = normalizeOrigin(req.headers.origin);

  if (origin) {
    if (isOriginAllowed(origin, allowlist)) {
      next();
      return;
    }

    denyOrigin(req, res, next, "CORS_DENIED", {
      reason: "origin-not-allowlisted",
      origin,
    });
    return;
  }

  if (hasNonBrowserCredential(req)) {
    next();
    return;
  }

  const refererOrigin = originFromReferer(req.headers.referer);
  if (refererOrigin && isOriginAllowed(refererOrigin, allowlist)) {
    next();
    return;
  }

  denyOrigin(req, res, next, "MISSING_ORIGIN", {
    reason: "missing-origin",
    origin: null,
  });
}

function denyOrigin(
  req: Request,
  res: Response,
  next: NextFunction,
  errorCode: "CORS_DENIED" | "MISSING_ORIGIN",
  details: { reason: string; origin: string | null },
): void {
  const context = {
    ...details,
    method: req.method,
    path: resolveFullPath(req),
    ip: req.ip,
  };

  if (getOriginEnforcementMode() === "report-only") {
    logger.warn(
      "[CORS] Origin guard violation (report-only, request allowed)",
      context,
    );
    next();
    return;
  }

  logger.warn("[CORS] Origin guard blocked request", context);
  sendApiError(res, 403, errorCode);
}

export default {
  corsMiddleware,
  corsErrorHandler,
  originGuard,
};
