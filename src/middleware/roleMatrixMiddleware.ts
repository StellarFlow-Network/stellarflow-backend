import { Request, Response, NextFunction } from "express";
import { sendApiError } from "../lib/apiError.js";
import { logAdminPermissionEvaluation } from "../services/adminAuditService.js";
import {
  Permission,
  Role,
  isAdminRole,
  roleHasPermission,
} from "../types/roles.js";

export interface AuthRequest extends Request {
  user?: {
    userId: number;
    email: string;
    role: string;
    group?: string;
    permissions?: string[];
  };
}

/**
 * Issue #1063 – Role-Based Access Control (RBAC) Engine.
 *
 * Paths that are considered administrative. Requests hitting these paths are
 * evaluated against the role matrix and every evaluation is audited.
 */
const SENSITIVE_PATHS = ["/admin", "/config", "/network", "/soroban", "/keys"];

/** Paths that expose or mutate relayer key material. */
const KEY_MANAGEMENT_PATHS = ["/keys", "/public-key", "/rotate-deks"];

export function isKeyManagementPath(path: string): boolean {
  const normalized = path.toLowerCase();

  return KEY_MANAGEMENT_PATHS.some((segment) => normalized.includes(segment));
}

function isSensitivePath(path: string): boolean {
  const normalized = path.toLowerCase();

  return SENSITIVE_PATHS.some((segment) => normalized.startsWith(segment));
}

function resolveIp(req: Request): string {
  return req.ip || "unknown";
}

function resolveUserAgent(req: Request): string {
  const header = req.headers["user-agent"];

  return typeof header === "string" ? header : "";
}

/**
 * Strict Group Permission Isolation Middleware.
 *
 * @param requiredPermission Permission required to reach the handler. When
 *   omitted, the caller only needs a valid authenticated session.
 * @param options.requireAdmin Restrict the route to ADMIN/SUPER_ADMIN sessions.
 */
export const enforceRoleMatrix = (
  requiredPermission?: Permission,
  options: { requireAdmin?: boolean } = {},
) => {
  return async (
    req: AuthRequest,
    res: Response,
    next: NextFunction,
  ): Promise<void> => {
    const user = req.user;
    const keyOperation = isKeyManagementPath(req.path);
    const auditBase = {
      userId: user?.userId,
      email: user?.email,
      role: user?.role,
      permission: requiredPermission,
      method: req.method,
      path: req.path,
      ipAddress: resolveIp(req),
      userAgent: resolveUserAgent(req),
      keyOperation,
    };

    if (!user) {
      await logAdminPermissionEvaluation({
        ...auditBase,
        granted: false,
        reason: "UNAUTHENTICATED",
      });

      sendApiError(res, 401, "UNAUTHORIZED", "Valid authentication required");
      return;
    }

    // Key management is strictly reserved for ADMIN sessions.
    if (keyOperation && !isAdminRole(user.role)) {
      await logAdminPermissionEvaluation({
        ...auditBase,
        granted: false,
        reason: "KEY_MANAGEMENT_REQUIRES_ADMIN",
      });

      sendApiError(
        res,
        403,
        "FORBIDDEN",
        "Key management operations require an ADMIN session",
      );
      return;
    }

    if (options.requireAdmin && !isAdminRole(user.role)) {
      await logAdminPermissionEvaluation({
        ...auditBase,
        granted: false,
        reason: "ADMIN_ROLE_REQUIRED",
      });

      sendApiError(res, 403, "FORBIDDEN", "ADMIN role required");
      return;
    }

    // Early blocking for sensitive paths.
    if (isSensitivePath(req.path) && user.role === ("OBSERVER" as Role)) {
      await logAdminPermissionEvaluation({
        ...auditBase,
        granted: false,
        reason: "ROLE_ISOLATION_VIOLATION",
      });

      sendApiError(
        res,
        403,
        "FORBIDDEN",
        "Observer keys cannot access administrative or configuration endpoints",
      );
      return;
    }

    // Permission check against the role matrix.
    if (requiredPermission && !roleHasPermission(user.role, requiredPermission)) {
      await logAdminPermissionEvaluation({
        ...auditBase,
        granted: false,
        reason: "INSUFFICIENT_PERMISSIONS",
      });

      sendApiError(
        res,
        403,
        "FORBIDDEN",
        `Role ${user.role} lacks permission: ${requiredPermission}`,
      );
      return;
    }

    await logAdminPermissionEvaluation({ ...auditBase, granted: true });
    next();
  };
};

// Convenience middleware
export const requireAdmin = enforceRoleMatrix(undefined, { requireAdmin: true });
export const requireOperator = enforceRoleMatrix("write:oracle");
export const requireAuditor = enforceRoleMatrix("read:audit");
export const requireKeyManagement = enforceRoleMatrix("write:keys", {
  requireAdmin: true,
});
