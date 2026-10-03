import { NextFunction, Request, Response } from "express";
import { sendApiError } from "../lib/apiError.js";
import { verifyAdminSessionToken } from "../utils/oidc.js";
import { ADMIN_SESSION_COOKIE } from "../config/oidc.js";

let hasWarnedAboutMissingAdminControls = false;

function getHeaderValue(
  value: string | string[] | undefined,
): string | undefined {
  if (Array.isArray(value)) {
    return value[0];
  }

  return value;
}

function matchesAdminIp(requestIp: string | undefined, adminIp: string): boolean {
  if (!requestIp) {
    return false;
  }

  return requestIp === adminIp || requestIp === `::ffff:${adminIp}`;
}

function getCookieValue(
  req: Request,
  name: string,
): string | undefined {
  const header = req.headers.cookie;
  if (!header) {
    return undefined;
  }

  for (const part of header.split(";")) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    if (key !== name) continue;
    const raw = trimmed.slice(eq + 1).trim();
    try {
      return decodeURIComponent(raw);
    } catch {
      return raw;
    }
  }

  return undefined;
}

export interface AdminSessionContext {
  email: string;
  subject: string;
  issuer: string;
  domain: string;
  name?: string;
  role: string;
  groups: string[];
  provider: string;
}

declare global {
  namespace Express {
    interface Request {
      adminSession?: AdminSessionContext;
    }
  }
}

/**
 * Admin authentication middleware.
 *
 * Authentication order (first match wins):
*   1. One of the legacy shared-secret guards (ADMIN_API_KEY/ADMIN_IP) if configured.
   2. OIDC session cookie issued by the Admin SSO flow.
 */
export const adminMiddleware = async (
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  const configuredAdminKey = process.env.ADMIN_API_KEY;
  const requestAdminKey = getHeaderValue(req.headers["x-admin-key"]);

  if (configuredAdminKey && requestAdminKey !== configuredAdminKey) {
    return sendApiError(res, 403, "INVALID_ADMIN_KEY");
  }

  const configuredAdminIp = process.env.ADMIN_IP;
  if (configuredAdminIp && !matchesAdminIp(req.ip, configuredAdminIp)) {
    return sendApiError(res, 403, "ADMIN_IP_DENIED");
  }

  const hasLegacyGuard = Boolean(configuredAdminKey || configuredAdminIp);

  // Attempt OIDC session authentication when a session cookie is present.
  const sessionToken = getCookieValue(req, ADMIN_SESSION_COOKIE);
  if (sessionToken) {
    const session = await verifyAdminSessionToken(sessionToken);
    if (!session) {
      return sendApiError(res, 401, "ADMIN_SESSION_INVALID");
    }

    req.adminSession = {
      email: session.email,
      subject: session.subject,
      issuer: session.issuer,
      domain: session.domain,
      name: session.name,
      role: session.role,
      groups: session.groups,
      provider: session.provider,
    };

    return next();
  }

  // No OIDC session cookie present. Fall back to legacy guards if configured.
  if (hasLegacyGuard) {
    return next();
  }

  if (!hasWarnedAboutMissingAdminControls) {
    hasWarnedAboutMissingAdminControls = true;
    console.warn(
      "[AdminMiddleware] No admin authentication is configured. Set ADMIN_API_KEY, ADMIN_IP, or OIDC provider credentials.",
    );
  }

  return sendApiError(res, 401, "ADMIN_AUTHENTICATION_REQUIRED");
};
