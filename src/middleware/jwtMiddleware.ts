import { NextFunction, Request, Response } from "express";
import { verifyToken, getActiveSession, cleanupExpiredSessions } from "../utils/jwt.js";

declare global {
  namespace Express {
    interface Request {
      user?: {
        userId: number;
        email: string;
        role: string;
        group?: string;
        permissions?: string[];
      };
      sessionId?: number;
    }
  }
}

const ADMIN_DOMAIN_ENV = "sso_admin_domains";

function getAuthorizedDomains(): string[] {
  const raw = process.env[ADMIN_DOMAIN_ENV];
  if (!raw) return [];
  return raw
    .split(",")
    .map((d) => d.trim().toLowerCase())
    .filter(Boolean);
}

function isAuthorizedDomain(email: string): boolean {
  const domains = getAuthorizedDomains();
  if (domains.length === 0) return false;
  const at = email.lastIndexOf("@");
  if (at === -1) return false;
  const domain = email.slice(at + 1).toLowerCase();
  return domains.some((allowed) => domain === allowed || domain.endsWith("." + allowed));
}

let sessionCleanupTimer: NodeJS.Timeout | null = null;

function startSessionCleanup(): void {
  if (sessionCleanupTimer) return;
  sessionCleanupTimer = setInterval(async () => {
    try {
      await cleanupExpiredSessions();
    } catch (error) {
      console.error("[JWT] Session cleanup error:", error);
    }
  }, 60 * 60 * 1000);
}

export const jwtMiddleware = async (
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  if (!sessionCleanupTimer) {
    startSessionCleanup();
  }

  const cookieToken = req.cookies?.admin_session;
  const authHeader = req.headers.authorization;
  const bearerToken = authHeader?.startsWith("Bearer ") ? authHeader.substring(7).trim() : undefined;
  const token = bearerToken || cookieToken;

  if (!token) {
    next();
    return;
  }

  const payload = verifyToken(token);

  if (!payload) {
    next();
    return;
  }

  if (!isAuthorizedDomain(payload.email)) {
    next();
    return;
  }

  const session = await getActiveSession(token);
  if (!session) {
    next();
    return;
  }

  (req as Request & { user: any }).user = {
    userId: payload.userId,
    email: payload.email,
    role: payload.role || "OBSERVER",
    group: payload.group,
    permissions: payload.permissions,
  };

  req.sessionId = session.relayerId;
  next();
};
