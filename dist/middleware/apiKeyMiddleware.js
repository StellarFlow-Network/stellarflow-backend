import crypto from "crypto";
import prisma from "../lib/prisma";
import { sendApiError } from "../lib/apiError.js";
import { hasScope, requiredScopeForMethod, } from "../types/apiKey.types";
// ------------------------------------------------------------------
// Helpers
// ------------------------------------------------------------------
/** SHA-256 hash of the raw key (what we store in the DB) */
function hashKey(rawKey) {
    return crypto.createHash("sha256").update(rawKey).digest("hex");
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
    return async function (req, res, next) {
        // ── 1. Extract raw key from header ──────────────────────────
        const rawKey = req.headers["x-api-key"];
        if (!rawKey || typeof rawKey !== "string" || rawKey.trim() === "") {
            sendApiError(res, 401, "MISSING_API_KEY");
            return;
        }
        // ── 2. Resolve the required scope ───────────────────────────
        const required = requiredScopeForMethod(req.method);
        if (required === null) {
            sendApiError(res, 405, "METHOD_NOT_ALLOWED", `HTTP method "${req.method}" is not supported.`);
            return;
        }
        // ── 3. Look up the hashed key in PostgreSQL ──────────────────
        let apiKeyRecord;
        try {
            apiKeyRecord = (await prisma.apiKey.findUnique({
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
            }));
        }
        catch (dbError) {
            console.error("[apiKeyAuth] DB lookup failed:", dbError);
            sendApiError(res, 503, "SERVICE_UNAVAILABLE", "Authentication service temporarily unavailable.");
            return;
        }
        // ── 4. Key not found ─────────────────────────────────────────
        if (!apiKeyRecord) {
            sendApiError(res, 401, "INVALID_API_KEY", "The provided API key is invalid.");
            return;
        }
        // ── 5. Key disabled ──────────────────────────────────────────
        if (!apiKeyRecord.isActive) {
            sendApiError(res, 403, "API_KEY_INACTIVE");
            return;
        }
        // ── 6. Key expired ───────────────────────────────────────────
        if (apiKeyRecord.expiresAt && apiKeyRecord.expiresAt < new Date()) {
            sendApiError(res, 403, "API_KEY_EXPIRED", `This API key expired on ${apiKeyRecord.expiresAt.toISOString()}.`);
            return;
        }
        // ── 7. Scope check ───────────────────────────────────────────
        if (!hasScope(apiKeyRecord.scopes, required)) {
            sendApiError(res, 403, "INSUFFICIENT_SCOPE", `This endpoint requires the "${required}" scope. ` +
                `Your key has: [${apiKeyRecord.scopes.join(", ") || "none"}].`);
            return;
        }
        // ── 8. Stamp req.apiKey and fire last-used update async ──────
        req.apiKey = {
            id: apiKeyRecord.id,
            label: apiKeyRecord.label,
            scopes: apiKeyRecord.scopes,
            ownerId: apiKeyRecord.ownerId,
        };
        // Non-blocking: update lastUsedAt in the background so we
        // don't add DB latency to every authenticated request.
        prisma.apiKey
            .update({
            where: { id: apiKeyRecord.id },
            data: { lastUsedAt: new Date() },
        })
            .catch((err) => console.warn("[apiKeyAuth] lastUsedAt update failed:", err.message));
        next();
    };
}
export const apiKeyMiddleware = apiKeyAuth();
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
function scopeGuard(scope) {
    return (_req, res, next) => {
        const key = _req.apiKey;
        if (!key) {
            sendApiError(res, 401, "UNAUTHENTICATED", "apiKeyAuth() must run before scopeGuard.");
            return;
        }
        if (!hasScope(key.scopes, scope)) {
            sendApiError(res, 403, "INSUFFICIENT_SCOPE", `This action requires the "${scope}" scope.`);
            return;
        }
        next();
    };
}
//# sourceMappingURL=apiKeyMiddleware.js.map