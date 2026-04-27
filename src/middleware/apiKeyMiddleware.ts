import { Request, Response, NextFunction } from "express";
import prisma from "../lib/prisma";

export const apiKeyMiddleware = async (
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  // Short-circuit if already authenticated by a previous middleware instance
  if (req.relayer) {
    next();
    return;
  }

  const apiKey = req.headers["x-api-key"];

  if (typeof apiKey !== "string" || apiKey.length === 0) {
    res.status(401).json({
      success: false,
      error: "Invalid or missing API key",
    });
    return;
  }

  try {
    // 1. Try to find an active relayer with this API key
    const relayer = await prisma.relayer.findFirst({
      where: {
        apiKey,
        isActive: true,
      },
    });

    if (relayer) {
      req.relayer = {
        id: relayer.id,
        name: relayer.name,
        allowedAssets: relayer.allowedAssets,
        publicKey: relayer.publicKey,
      };
      next();
      return;
    }

    // 2. Fall back to global API key for backward compatibility
    const expectedKey = process.env.API_KEY;

    if (!expectedKey) {
      console.error("Critical: API_KEY not set in environment");
      res.status(500).json({
        success: false,
        error: "Authentication configuration error",
      });
      return;
    }

    if (apiKey === expectedKey) {
      next();
      return;
    }

    res.status(401).json({
      success: false,
      error: "Invalid or missing API key",
    });
  } catch (error) {
    console.error("[apiKeyMiddleware] Error during authentication:", error);
    res.status(500).json({
      success: false,
      error: "Authentication check failed",
    });
  }
};

import crypto from "crypto";
import { Request, Response, NextFunction } from "express";
import { PrismaClient } from "@prisma/client";
import {
  ApiScope,
  AuthenticatedApiKey,
  hasScope,
  requiredScopeForMethod,
} from "../types/apiKey.types";

// ------------------------------------------------------------------
// Module-level Prisma singleton — reuse the one from src/lib/prisma
// if your project already exports it; otherwise import directly.
// ------------------------------------------------------------------
const prisma = new PrismaClient();

// ------------------------------------------------------------------
// Extend Express's Request so downstream handlers can safely access
// req.apiKey without casting.
// ------------------------------------------------------------------
declare global {
  namespace Express {
    interface Request {
      apiKey?: AuthenticatedApiKey;
    }
  }
}

// ------------------------------------------------------------------
// Helpers
// ------------------------------------------------------------------

/** SHA-256 hash of the raw key (what we store in the DB) */
function hashKey(rawKey: string): string {
  return crypto.createHash("sha256").update(rawKey).digest("hex");
}

/** Unified error shape so API consumers get consistent JSON */
function sendError(
  res: Response,
  status: number,
  code: string,
  message: string
): void {
  res.status(status).json({
    success: false,
    error: { code, message },
  });
}

// ------------------------------------------------------------------
// Main middleware factory
// ------------------------------------------------------------------

/**
 * `apiKeyAuth()`
 *
 * Drop this onto any router or individual route that needs
 * API-key protection:
 *
 *   router.use(apiKeyAuth());          // protect all verbs
 *   router.post("/prices", apiKeyAuth(), handler);  // just POST
 *
 * The middleware automatically maps the HTTP method to the
 * required scope, so you never have to pass a scope manually.
 */
export function apiKeyAuth() {
  return async function (
    req: Request,
    res: Response,
    next: NextFunction
  ): Promise<void> {
    // ── 1. Extract raw key from header ──────────────────────────
    const rawKey = req.headers["x-api-key"];

    if (!rawKey || typeof rawKey !== "string" || rawKey.trim() === "") {
      sendError(
        res,
        401,
        "MISSING_API_KEY",
        "Request must include a valid X-API-Key header."
      );
      return;
    }

    // ── 2. Resolve the required scope ───────────────────────────
    const required = requiredScopeForMethod(req.method);

    if (required === null) {
      sendError(
        res,
        405,
        "METHOD_NOT_ALLOWED",
        `HTTP method "${req.method}" is not supported.`
      );
      return;
    }

    // ── 3. Look up the hashed key in PostgreSQL ──────────────────
    let apiKeyRecord: {
      id: string;
      label: string | null;
      scopes: ApiScope[];
      ownerId: string | null;
      isActive: boolean;
      expiresAt: Date | null;
      lastUsedAt: Date | null;
    } | null;

    try {
      apiKeyRecord = await prisma.apiKey.findUnique({
        where: { key: hashKey(rawKey.trim()) },
        select: {
          id: true,
          label: true,
          scopes: true,
          ownerId: true,
          isActive: true,
          expiresAt: true,
          lastUsedAt: true,
        },
      }) as typeof apiKeyRecord;
    } catch (dbError) {
      console.error("[apiKeyAuth] DB lookup failed:", dbError);
      sendError(
        res,
        503,
        "SERVICE_UNAVAILABLE",
        "Authentication service temporarily unavailable."
      );
      return;
    }

    // ── 4. Key not found ─────────────────────────────────────────
    if (!apiKeyRecord) {
      sendError(res, 401, "INVALID_API_KEY", "The provided API key is invalid.");
      return;
    }

    // ── 5. Key disabled ──────────────────────────────────────────
    if (!apiKeyRecord.isActive) {
      sendError(res, 403, "API_KEY_INACTIVE", "This API key has been revoked.");
      return;
    }

    // ── 6. Key expired ───────────────────────────────────────────
    if (apiKeyRecord.expiresAt && apiKeyRecord.expiresAt < new Date()) {
      sendError(
        res,
        403,
        "API_KEY_EXPIRED",
        `This API key expired on ${apiKeyRecord.expiresAt.toISOString()}.`
      );
      return;
    }

    // ── 7. Scope check ───────────────────────────────────────────
    if (!hasScope(apiKeyRecord.scopes as ApiScope[], required)) {
      sendError(
        res,
        403,
        "INSUFFICIENT_SCOPE",
        `This endpoint requires the "${required}" scope. ` +
          `Your key has: [${apiKeyRecord.scopes.join(", ") || "none"}].`
      );
      return;
    }

    // ── 8. Stamp req.apiKey and fire last-used update async ──────
    req.apiKey = {
      id: apiKeyRecord.id,
      label: apiKeyRecord.label,
      scopes: apiKeyRecord.scopes as ApiScope[],
      ownerId: apiKeyRecord.ownerId,
    };

    // Non-blocking: update lastUsedAt in the background so we
    // don't add DB latency to every authenticated request.
    prisma.apiKey
      .update({
        where: { id: apiKeyRecord.id },
        data: { lastUsedAt: new Date() },
      })
      .catch((err: Error) =>
        console.warn("[apiKeyAuth] lastUsedAt update failed:", err.message)
      );

    next();
  };
}

// ------------------------------------------------------------------
// Optional: scope-specific shorthand helpers
// Use these when you want to lock a single route to one scope
// regardless of the HTTP method (e.g., an admin GET that touches
// sensitive data and should require write scope).
// ------------------------------------------------------------------

/** Require the "read" scope explicitly (ignores HTTP method). */
export function requireReadScope() {
  return scopeGuard("read");
}

/** Require the "write" scope explicitly (ignores HTTP method). */
export function requireWriteScope() {
  return scopeGuard("write");
}

function scopeGuard(scope: ApiScope) {
  return (_req: Request, res: Response, next: NextFunction): void => {
    const key = _req.apiKey;

    if (!key) {
      sendError(res, 401, "UNAUTHENTICATED", "apiKeyAuth() must run before scopeGuard.");
      return;
    }

    if (!hasScope(key.scopes, scope)) {
      sendError(
        res,
        403,
        "INSUFFICIENT_SCOPE",
        `This action requires the "${scope}" scope.`
      );
      return;
    }

    next();
  };
}