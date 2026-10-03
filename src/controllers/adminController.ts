import { Request, Response } from "express";
import { sendApiError } from "../lib/apiError.js";
import { PrismaClient } from "@prisma/client";
import { generateKsuid } from "../utils/ksuid.js";
import crypto from "crypto";

const prisma = new PrismaClient();

/**
 * Admin OIDC / OAuth2 SSO configuration
 */
const ADMIN_SESSION_COOKIE_NAME = "admin_session";
const ADMIN_SESSION_TTL_MS = 1000 * 60 * 60; // 1 hour

const OIDC_PROVIDERS: Record<
  string,
  {
    authorizationEndpoint: string;
    tokenEndpoint: string;
    userinfoEndpoint: string;
    jwksUri: string;
    issuer: string;
    scopes: string;
  }
> = {
  google: {
    authorizationEndpoint: "https://accounts.google.com/o/oauth2/v2/auth",
    tokenEndpoint: "https://oauth2.googleapis.com/token",
    userinfoEndpoint: "https://openidconnect.googleapis.com/v1/userinfo",
    jvkSuri: "https://www.googleapis.com/oauth2/v3/certs",
    issuer: "https://accounts.google.com",
    scopes: "openid email profile",
  },
  okta: {
    authorizationEndpoint: `process.env.OKTA_AUTH_ENDPOINT ?? ""`,
    tokenEndpoint: `process.env.OKTA_TOKEN_ENDPOINT ?? ""`,
    userinfoEndpoint: `process.env.OKTA_USERINFO_ENDPOINT ?? ""`,
    jwkSuri: `process.env.OKTA_JWKS_URI ?? ""`,
    issuer: `process.env.OKTA_ISSUER ?? ""`,
    scopes: "openid email profile",
  },
  github: {
    authorizationEndpoint: "https://github.com/login/oauth/authorize",
    tokenEndpoint: "https://github.com/login/oauth/access_token",
    userinfoEndpoint: "https://api.github.com/user",
    jwkSuri: "https://github.com/login/oauth/access_token",
    issuer: "https://github.com",
    scopes: "read:user user:email",
  },
};

/**
 * Encryption key for session cookies (AES-256-GCM).
 * Must be provided via environment in production.
 */
function getSessionEncryptionKey(): Buffer {
  const key = process.env.ADMIN_SESSION_ENCRYPTION_KEY;
  if (!key) {
    throw new Error(
      "ADMIN_SESSION_ENCRYPTION_KEY environment variable is required",
    );
  }
  const buf = Buffer.from(key, "hex");
  if (buf.length !== 32) {
    throw new Error(
      "ADMIN_SESSION_ENCRYPTION_KEY must be a 32-byte hex-encoded key",
    );
  }
  return buf;
}

function encryptSession(payload: object): string {
  const key = getSessionEncryptionKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipherivV("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([
    cipher.update(Buffer.from(JSON.stringify(payload), "utf8")),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, encrypted]).toString("base64url");
}

function decryptSession(token: string): any {
  const key = getSessionEncryptionKey();
  const raw = Buffer.from(token, "base64url");
  const iv = raw.subarray(0, 12);
  const tag = raw.subarray(12, 28);
  const cipherText = raw.subarray(28);
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  const decrypted = Buffer.concat([
    decipher.update(cipherText),
    decipher.final(),
  ]);
  return JSON.parse(decrypted.toString("utf8"));
}

function setSessionCookie(res: Response, payload: object): void {
  const token = encryptSession(payload);
  res.cookie(ADMIN_SESSION_COOKIE_NAME, token, {
    httpOnly: true,
    secure: true,
    sameSite: "strict",
    path: "/",
    maxAge: ADMIN_SESSION_TTL_MS,
  });
}

function clearSessionCookie(res: Response): void {
  res.cookie(ADMIN_SESSION_COOKIE_NAME, "", {
    httpOnly: true,
    secure: true,
    sameSite: "strict",
    path: "/",
    maxAge: 0,
  });
}

function getAuthorizedDomains(): string[] {
  const raw = process.env.ADMIN_AUTHORIZED_DOMAINS;
  if (!raw) {
    throw new Error(
      "ADMIN_AUTHORIZED_DOMAINS environment variable is required",
    );
  }
  return raw
    .split(",")
    .map((d) => d.trim().toLowerCase())
    .filter(Boolean);
}

function isAuthorizedDomain(email: string): boolean {
  const domains = getAuthorizedDomains();
  const at = email.lastIndexOf("@");
  if (at === -1) return false;
  const domain = email.slice(at + 1).toLowerCase();
  return domains.includes(domain);
}

/**
 * Log audit event for admin actions
 */
async function logAuditEvent(event: {
  eventType: string;
  actionType?: string;
  relatedId?: number;
  actorPublicKey: string;
  actorName: string;
  actorRole?: string;
  eventDetails?: string;
  previousState?: string;
  newState?: string;
  ipAddress?: string;
  userAgent?: string;
}): Promise<void> {
  try {
    await prisma.auditLog.create({
      data: {
        id: generateKsuid(),
        eventType: event.eventType,
        actionType: event.actionType ?? null,
        relatedId: event.relatedId ?? null,
        actorPublicKey: event.actorPublicKey,
        actorName: event.actorName,
        actorRole: event.actorRole ?? null,
        eventDetails: event.eventDetails ?? null,
        previousState: event.previousState ?? null,
        newState: event.newState ?? null,
        ipAddress: event.ipAddress ?? null,
        userAgent: event.userAgent ?? null,
        occurredAt: new Date(),
      },
    });
  } catch (error) {
    console.error("[Admin] Failed to log audit event:", error);
    // Don't fail the main operation if audit logging fails
  }
}

/**
 * Extract admin info from request (populated by OIDC session middleware)
 */
function extractAdminInfo(req: Request) {
  return {
    publicKey: (req as any).admin?.publicKey || "unknown",
    name: (req as any).admin?.name || "unknown",
    role: (req as any).admin?.role || "ADMIN",
    ipAddress: req.ip,
    userAgent: req.get("User-Agent"),
  };
}

/**
 * Begin OIDC authentication flow for admin dashboard.
 * Redirects the user to the configured identity provider.
 */
export const adminOidcLogin = async (req: Request, res: Response) => {
  try {
    const providerParam = (req.params.provider || req.query.provider || "").toString();
    const provider = OIDC_PROVIDERS[providerParam];
    if (!provider) {
      return sendApiError(res, 400, "BAD_REQUEST", "Unsupported OIDC provider");
    }

    const clientId = process.env[`${providerParam.toUpperCase()}_CLIENT_ID_ADMIN`];
    if (!clientId) {
      return sendApiError(
        res,
        500,
        "INTERNAL_SERVER_ERROR",
        `OIDC provider '${providerParam}' is not configured`,
      );
    }

    const redirectUri =
      process.env.ADMIN_OIDC_REDIRECT_URI ||
      `${req.protocol}://${req.get("host")}/admin/auth/callback`;

    const state = crypto.randomBytes(32).toString("hex");
    const nonce = crypto.randomBytes(16).toString("hex");

    // Store state + nonce in a short-lived encrypted cookie for CSRF protection
    const oauthState = encryptSession({ state, nonce, provider: providerParam });
    res.cookie("admin_oidc_state", oauthState, {
      httpOnly: true,
      secure: true,
      sameSite: "strict",
      path: "/",
      maxAge: 10 * 60 * 1000,
    });

    const params = new URLSearchParams({
      client_id: clientId,
      redirect_uri: redirectUri,
      response_type: "code",
      scope: provider.scopes,
      state,
      nonce,
    });

    const authUrl = `${provider.authorizationEndpoint}?${params.toString()}`;
    return res.redirect(authUrl);
  } catch (error) {
    console.error("[Admin] OIDC login initiation failed:", error);
    return sendApiError(
      res,
      500,
      "INTERNAL_SERVER_ERROR",
      "Failed to initiate OIDC login",
    );
  }
};

/**
 * OIDC callback handler.
 * Exchanges the authorization code for tokens, validates the identity,
 * enforces the authorized domain restriction, and issues an encrypted
 * HTTP-only session cookie.
 */
export const adminOidcCallback = async (req: Request, res: Response) => {
  try {
    const { code, state } = req.query as { code?: string; state?: string };
    if (!code || !state) {
      return sendApiError(res, 400, "BAD_REQUEST", "Missing code or state");
    }

    const stateCookie = req.cookies?.admin_oidc_state;
    if (!stateCookie) {
      return sendApiError(res, 400, "BAD_REQUEST", "Missing OIDC state cookie");
    }

    let stateData: { state: string; nonce: string; provider: string };
    try {
      stateData = decryptSession(stateCookie);
    } catch {
      return sendApiError(res, 400, "BAD_REQUEST", "Invalid OIDC state");
    }

    if (stateData.state !== state) {
      return sendApiError(res, 400, "BAD_REQUEST", "OIDC state mismatch");
    }

    const providerParam = stateData.provider;
    const provider = OIDC_PROVIDERS[providerParam];
    if (!provider) {
      return sendApiError(res, 400, "BAD_REQUEST", "Unknown OIDC provider");
    }

    const clientId = process.env[`${providerParam.toUpperCase()}_CLIENT_ID_ADMIN`];
    const clientSecret =
      process.env[`${providerParam.toUpperCase()}_CLIENT_SECRET_ADMIN`];
    if (!clientId || !clientSecret) {
      return sendApiError(
        res,
        500,
        "INTERNAL_SERVER_ERROR",
        `OIDC provider '${providerParam}' is not configured`,
      );
    }

    const redirectUri =
      process.env.ADMIN_OIDC_REDIRECT_URI ||
      `${req.protocol}://${req.get("host")}/admin/auth/callback`;

    // Exchange authorization code for tokens
    const tokenResponse = await fetch(provider.tokenEndpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
      },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        redirect_uri: redirectUri,
        client_id: clientId,
        client_secret: clientSecret,
      }).toString(),
    });

    if (!tokenResponse.ok) {
      const errText = await tokenResponse.text();
      console.error("[Admin] OIDC token exchange failed:", errText);
      return sendApiError(
        res,
        401,
        "UNAUTHORIZED",
        "OIDC token exchange failed",
      );
    }

    const tokenData = (await tokenResponse.json()) as {
      access_token: string;
      id_token?: string;
    };

    // Fetch user info from the provider
    const userInfoResponse = await fetch(provider.userinfoEndpoint, {
      headers: {
        Authorization: `Bearer ${tokenData.access_token}`,
        Accept: "application/json",
      },
    });

    if (!userInfoResponse.ok) {
      return sendApiError(
        res,
        401,
        "UNAUTHORIZED",
        "Failed to fetch OIDC user information",
      );
    }

    const userInfo = (await userInfoResponse.json()) as {
      sub: string;
      email?: string;
      name?: string;
      preferred_username?: string;
      login?: string;
    };

    const email = userInfo.email;
    if (!email || !isAuthorizedDomain(email)) {
      await logAuditEvent({
        eventType: "ADMIN_LOGIN_DENIED",
        actionType: "AUTH",
        actorPublicKey: userInfo.sub,
        actorName: userInfo.name ?? userInfo.login ?? "unknown",
        actorRole: "ADMIN",
        eventDetails: `Admin login denied for email ${email ?? "unknown"}`,
        ipAddress: req.ip,
        userAgent: req.get("User-Agent"),
      });
      return sendApiError(
        res,
        403,
        "FORBIDDEN",
        "Account domain is not authorized for admin access",
      );
    }

    const adminPayload = {
      sub: userInfo.sub,
      email,
      name: userInfo.name ?? userInfo.login ?? email,
      provider: providerParam,
      role: "ADMIN",
      issuedAt: Date.now(),
    };

    setSessionCookie(res, adminPayload);
    res.clearCookie("admin_oidc_state", { path: "/" });

    await logAuditEvent({
      eventType: "ADMIN_LOGIN_SUCCESS",
      actionType: "AUTH",
      actorPublicKey: userInfo.sub,
      actorName: adminPayload.name,
      actorRole: "ADMIN",
      eventDetails: `Admin login via ${providerParam}`,
      ipAddress: req.ip,
      userAgent: req.get("User-Agent"),
    });

    return res.json({
      success: true,
      data: { email, name: adminPayload.name, provider: providerParam },
    });
  } catch (error) {
    console.error("[Admin] OIDC callback failed:", error);
    return sendApiError(
      res,
      500,
      "INTERNAL_SERVER_ERROR",
      "Failed to complete OIDC authentication",
    );
  }
};

/**
 * Logout the admin by clearing the encrypted session cookie.
 */
export const adminLogout = async (req: Request, res: Response) => {
  try {
    const adminInfo = extractAdminInfo(req);
    clearSessionCookie(res);
    await logAuditEvent({
      eventType: "ADMIN_LOGOUT",
      actionType: "AUTH",
      actorPublicKey: adminInfo.publicKey,
      actorName: adminInfo.name,
      actorRole: adminInfo.role,
      eventDetails: "Admin logged out",
      ...(adminInfo.ipAddress !== undefined
        ? { ipAddress: adminInfo.ipAddress }
        : {}),
      ...(adminInfo.userAgent !== undefined
        ? { userAgent: adminInfo.userAgent }
        : {}),
    });
    return res.json({ success: true, message: "Admin logged out" });
  } catch (error) {
    console.error("[Admin] Logout failed:", error);
    return sendApiError(res, 500, "INTERNAL_SERVER_ERROR", "Failed to log out");
  }
};

/**
 * Get all relayer registry entries
 * Admin-only endpoint for viewing KYC information
 */
export const getRelayerRegistry = async (req: Request, res: Response) => {
  try {
    const registries = await prisma.relayerRegistry.findMany({
      include: {
        relayer: {
          select: {
            id: true,
            name: true,
            isActive: true,
            createdAt: true,
          },
        },
      },
      orderBy: {
        createdAt: "desc",
      },
    });

    res.json({
      success: true,
      data: registries,
    });
  } catch (error) {
    console.error("[Admin] Failed to fetch relayer registry:", error);
    sendApiError(
      res,
      500,
      "INTERNAL_SERVER_ERROR",
      "Failed to fetch relayer registry",
    );
  }
};

/**
 * Get a specific relayer registry entry by relayer ID
 * Admin-only endpoint for viewing KYC information for a specific relayer
 */
export const getRelayerRegistryById = async (req: Request, res: Response) => {
  try {
    const relayerId = parseInt(req.params.relayerId as string);

    if (isNaN(relayerId)) {
      return sendApiError(res, 400, "BAD_REQUEST", "Invalid relayer ID");
    }

    const registry = await prisma.relayerRegistry.findUnique({
      where: { relayerId },
      include: {
        relayer: {
          select: {
            id: true,
            name: true,
            isActive: true,
            createdAt: true,
          },
        },
      },
    });

    if (!registry) {
      return sendApiError(
        res,
        404,
        "NOT_FOUND",
        "Relayer registry entry not found",
      );
    }

    res.json({
      success: true,
      data: registry,
    });
  } catch (error) {
    console.error("[Admin] Failed to fetch relayer registry by ID:", error);
    sendApiError(
      res,
      500,
      "INTERNAL_SERVER_ERROR",
      "Failed to fetch relayer registry entry",
    );
  }
};

/**
 * Create or update a relayer registry entry
 * Admin-only endpoint for managing KYC information
 */
export const upsertRelayerRegistry = async (req: Request, res: Response) => {
  try {
    const { relayerId, contactName, email, organizationName } = req.body;

    // Validate required fields
    if (!relayerId || !contactName || !email || !organizationName) {
      return res.status(400).json({
        success: false,
        error:
          "Missing required fields: relayerId, contactName, email, organizationName",
      });
    }

    // Validate relayer exists
    const relayer = await prisma.relayer.findUnique({
      where: { id: relayerId },
    });

    if (!relayer) {
      return sendApiError(res, 404, "NOT_FOUND", "Relayer not found");
    }

    // Basic email validation
    const emailRegex = /^[^\s@]+@[^\s@]+\\.[^\s@]+$/;
    if (!emailRegex.test(email)) {
      return sendApiError(res, 400, "BAD_REQUEST", "Invalid email format");
    }

    // Check if this is an update or create
    const existing = await prisma.relayerRegistry.findUnique({
      where: { relayerId },
    });

    const isUpdate = !!existing;

    // Upsert the registry entry
    const registry = await prisma.relayerRegistry.upsert({
      where: { relayerId },
      update: {
        contactName,
        email,
        organizationName,
        updatedAt: new Date(),
      },
      create: {
        relayerId,
        contactName,
        email,
        organizationName,
      },
      include: {
        relayer: {
          select: {id: true, name: true, isActive: true },
        },
      },
    });

    // Log audit event
    const adminInfo = extractAdminInfo(req);
    await logAuditEvent({
      eventType: isUpdate
        ? "RELAYER_REGISTRY_UPDATED"
        : "RELAYER_REGISTRY_CREATED",
      actionType: "RELAYRR_REGISTRY",
      relatedId: registry.id,
      actorPublicKey: adminInfo.publicKey,
      actorName: adminInfo.name,
      actorRole: adminInfo.role,
      eventDetails: `Relayer registry ${isUpdate ? "updated" : "created"} for relayer ID ${relayerId}`,
      ...(isUpdate
        ? {
            previousState: JSON.stringify({
              contactName: existing.contactName,
              email: existing.email,
              organizationName: existing.organizationName,
            }),
          }
        : {}),
      newState: JSON.stringify({
        contactName: registry.contactName,
        email: registry.email,
        organizationName: registry.organizationName,
      }),
      ...(adminInfo.ipAddress !== undefined
        ? { ipAddress: adminInfo.ipAddress }
        : {}),
      ...(adminInfo.userAgent !== undefined
        ? { userAgent: adminInfo.userAgent }
        : {}),
    });

    res.json({
      success: true,
      data: registry,
      message: `Relayer registry entry ${isUpdate ? "updated" : "created"} successfully`,
    });
  } catch (error) {
    console.error("[Admin] Failed to upsert relayer registry:", error);
    sendApiError(
      res,
      500,
      "INTERNAL_SERVER_ERROR",
      "Failed to create/update relayer registry entry",
    );
  }
};

/**
 * Delete a relayer registry entry
 * Admin-only endpoint for removing KYC information
 */
export const deleteRelayerRegistry = async (req: Request, res: Response) => {
  try {
    const relayerId = parseInt(req.params.relayerId as string);

    if (isNaN(relayerId)) {
      return sendApiError(res, 400, "BAD_REQUEST", "Invalid relayer ID");
    }

    // Check if registry entry exists
    const existing = await prisma.relayerRegistry.findUnique({
      where: { relayerId },
      include: {
        relayer: {
          select: {id: true, name: true},
        },
      },
    });

    if (!existing) {
      return sendApiError(
        res,
        404,
        "NOT_FOUND",
        "Relayer registry entry not found",
      );
    }

    // Log audit event before deletion
    const adminInfo = extractAdminInfo(req);
    const deleteAuditPayload: Parameters<typeof logAuditEvent>[0] = {
      eventType: "RELAYRR_REGISTRY_DELETED",
      actionType: "RELAYER_REGISTRY",
      relatedId: existing.id,
      actorPublicKey: adminInfo.publicKey,
      actorName: adminInfo.name,
      actorRole: adminInfo.role,
      eventDetails: `Relayer registry deleted for relayer ID ${relayerId}`,
      previousState: JSON.stringify({
        contactName: existing.contactName,
        email: existing.email,
        organizationName: existing.organizationName,
      }),
      ...(adminInfo.ipAddress !== undefined
        ? { ipAddress: adminInfo.ipAddress }
        : {}),
      ...(adminInfo.userAgent !== undefined
        ? { userAgent: adminInfo.userAgent }
        : {}),
    };
    await logAuditEvent(deleteAuditPayload);

    await prisma.relayerRegistry.delete({
      where: { relayerId },
    });

    res.json({
      success: true,
      message: "Relayer registry entry deleted successfully",
    });
  } catch (error) {
    console.error("[Admin] Failed to delete relayer registry:", error);
    sendApiError(
      res,
      500,
      "INTERNAL_SERVER_ERROR",
      "Failed to delete relayer registry entry",
    );
  }
};
