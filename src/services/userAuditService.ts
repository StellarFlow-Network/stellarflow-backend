import { prisma } from "../lib/prisma.js";

export enum UserAuditEventType {
  USER_LOGIN_SUCCESS = "USER_LOGIN_SUCCESS",
  USER_LOGIN_FAILED = "USER_LOGIN_FAILED",
  USER_LOGOUT = "USER_LOGOUT",
  PERMISSION_GRANTED = "PERMISSION_GRANTED",
  PERMISSION_REVOKED = "PERMISSION_REVOKED",
  ROLE_CHANGED = "ROLE_CHANGED",
  USER_CREATED = "USER_CREATED",
  USER_DEACTIVATED = "USER_DEACTIVATED",
  SESSION_EXPIRED = "SESSION_EXPIRED",
}

export interface AuditContext {
  userId?: number;
  actorId?: number;
  ipAddress: string;
  userAgent: string;
  resourceType: "USER" | "SESSION" | "PERMISSION";
  resourceId: number;
  action: UserAuditEventType;
  before?: Record<string, unknown>;
  after?: Record<string, unknown>;
}

export async function logUserAccessEvent(ctx: AuditContext): Promise<void> {
  const { userId, actorId, ipAddress, userAgent, resourceType, resourceId, action, before, after } = ctx;

  await prisma.auditLog.create({
    data: {
      eventType: action,
      actorPublicKey: userId ? `user:${userId}` : "system",
      actorName: userId ? `user:${userId}` : "system",
      actorRole: "USER",
      eventDetails: JSON.stringify({
        resourceType,
        resourceId,
        ...(before && { before }),
        ...(after && { after }),
      }),
      previousState: before ? JSON.stringify(before) : null,
      newState: after ? JSON.stringify(after) : null,
      ipAddress: ipAddress || null,
      userAgent: userAgent || null,
      occurredAt: new Date(),
    },
  });
}

export async function logLoginSuccess(
  userId: number,
  ipAddress: string,
  userAgent: string,
): Promise<void> {
  const user = await prisma.relayer.findUnique({
    where: { id: userId },
    select: { email: true, role: true },
  });

  await logUserAccessEvent({
    userId,
    ipAddress,
    userAgent,
    resourceType: "SESSION",
    resourceId: userId,
    action: UserAuditEventType.USER_LOGIN_SUCCESS,
    after: { email: user?.email, role: user?.role, loginAt: new Date() },
  });
}

export async function logLoginFailed(
  email: string,
  ipAddress: string,
  userAgent: string,
  reason: string,
): Promise<void> {
  await prisma.auditLog.create({
    data: {
      eventType: UserAuditEventType.USER_LOGIN_FAILED,
      actorPublicKey: `email:${email}`,
      actorName: `email:${email}`,
      actorRole: "USER",
      eventDetails: JSON.stringify({ reason, email }),
      ipAddress: ipAddress || null,
      userAgent: userAgent || null,
      occurredAt: new Date(),
    },
  });
}

export async function logLogout(
  userId: number,
  ipAddress: string,
  userAgent: string,
): Promise<void> {
  await logUserAccessEvent({
    userId,
    ipAddress,
    userAgent,
    resourceType: "SESSION",
    resourceId: userId,
    action: UserAuditEventType.USER_LOGOUT,
  });
}

export async function logPermissionChange(
  actorId: number,
  targetId: number,
  field: string,
  oldValue: unknown,
  newValue: unknown,
  ipAddress: string,
  userAgent: string,
): Promise<void> {
  await prisma.permissionChange.create({
    data: {
      relayerId: targetId,
      changedBy: actorId,
      targetId,
      field,
      oldValue: JSON.stringify(oldValue),
      newValue: JSON.stringify(newValue),
    },
  });

  const action =
    field === "role"
      ? UserAuditEventType.ROLE_CHANGED
      : newValue === true || newValue === "true"
        ? UserAuditEventType.PERMISSION_GRANTED
        : UserAuditEventType.PERMISSION_REVOKED;

  await logUserAccessEvent({
    userId: targetId,
    actorId,
    ipAddress,
    userAgent,
    resourceType: "PERMISSION",
    resourceId: targetId,
    action,
    before: { [field]: oldValue },
    after: { [field]: newValue },
  });
}