import { prisma } from "../lib/prisma.js";
import { generateKsuid } from "../utils/ksuid.js";
import { nowUTC } from "../utils/timeUtils.js";
import type { Permission } from "../types/roles.js";

/**
 * Issue #1063 – RBAC Engine for the Relayer Admin API.
 *
 * Every administrative permission evaluation (granted or denied) is persisted
 * to the PostgreSQL audit database so that access decisions are traceable.
 */
export enum AdminAuditEventType {
  ADMIN_ACCESS_GRANTED = "ADMIN_ACCESS_GRANTED",
  ADMIN_ACCESS_DENIED = "ADMIN_ACCESS_DENIED",
  ADMIN_KEY_ACCESS_GRANTED = "ADMIN_KEY_ACCESS_GRANTED",
  ADMIN_KEY_ACCESS_DENIED = "ADMIN_KEY_ACCESS_DENIED",
}

export interface AdminPermissionAuditContext {
  userId?: number;
  email?: string;
  role?: string;
  permission?: Permission;
  method: string;
  path: string;
  ipAddress?: string;
  userAgent?: string;
  granted: boolean;
  reason?: string;
  keyOperation?: boolean;
}

/**
 * Persist a single admin permission evaluation. Audit failures must never
 * break the request pipeline, so errors are logged and swallowed.
 */
export async function logAdminPermissionEvaluation(
  ctx: AdminPermissionAuditContext,
): Promise<void> {
  const {
    userId,
    email,
    role,
    permission,
    method,
    path,
    ipAddress,
    userAgent,
    granted,
    reason,
    keyOperation,
  } = ctx;

  const eventType = keyOperation
    ? granted
      ? AdminAuditEventType.ADMIN_KEY_ACCESS_GRANTED
      : AdminAuditEventType.ADMIN_KEY_ACCESS_DENIED
    : granted
      ? AdminAuditEventType.ADMIN_ACCESS_GRANTED
      : AdminAuditEventType.ADMIN_ACCESS_DENIED;

  const actor = userId ? `user:${userId}` : email ? `email:${email}` : "anonymous";

  try {
    await prisma.auditLog.create({
      data: {
        id: generateKsuid(),
        eventType,
        actionType: keyOperation ? "KEY_MANAGEMENT" : "ADMIN_ACCESS",
        actorPublicKey: actor,
        actorName: email || actor,
        actorRole: role || "UNKNOWN",
        eventDetails: JSON.stringify({
          permission: permission ?? null,
          method,
          path,
          granted,
          keyOperation: !!keyOperation,
          ...(reason && { reason }),
        }),
        ipAddress: ipAddress || null,
        userAgent: userAgent || null,
        occurredAt: nowUTC(),
      },
    });
  } catch (error) {
    console.error("[AdminAudit] Failed to persist permission evaluation:", error);
  }
}
