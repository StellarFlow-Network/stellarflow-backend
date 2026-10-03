import { prisma } from "../lib/prisma.js";
import { Keypair } from "@stellar/stellar-sdk";
import crypto from "crypto";
import { URLSearchParams } from "url";
import { cryptographicNonceStore } from "../services/nonceStoreService.js";
import { normalizeHexString } from "../middleware/signatureVerificationMiddleware.js";
import {
  generateToken,
  verifyPassword,
  createUserSession,
  invalidateSession,
  generateRefreshToken,
  verifyRefreshToken,
  isRefreshTokenBlacklisted,
  blacklistRefreshToken,
} from "../utils/jwt.js";
import {
  logLoginSuccess,
  logLoginFailed,
  logLogout,
} from "../services/userAuditService.js";
import {
  bruteForceGuard,
  recordFailedAttempt,
  clearBruteForceRecord,
} from "../middleware/bruteForceMiddleware.js";
import express from "express";
import crypto from "crypto";
import { sendApiError } from "../lib/apiError.js";
import { storeEncryptedSession, revokeSessionByToken } from "../utils/jwt.js";

const router = express.Router();

// ── OIDC / OAuth2 SSO Configuration ─────────────────────────────────────────
type OidcProvider = "google" | "okta" | "github";

interface OidcProviderConfig {
  clientId: string;
  clientSecret: string;
  authorizeUrl: string;
  tokenUrl: string;
  userInfoUrl: string;
  scopes: string[];
  emailClaim: string;
  domainClaim?: string;
}

const OIDC_PROVIDERS: Record<OidcProvider, OidcProviderConfig> = {
  google: {
    clientId: process.env.GOOGLE_CLIENT_ID || "",
    clientSecret: process.env.GOOGLE_CLIENT_SECRET || "",
    authorizeUrl: "https://accounts.google.com/o/oauth2/v2/auth",
    tokenUrl: "https://oauth2.googleapis.com/token",
    userInfoUrl: "https://openidconnect.googleapis.com/v1/userinfo",
    scopes: ["openid", "email", "profile"],
    emailClaim: "email",
    domainClaim: "hd",
  },
  okta: {
    clientId: process.env.OKTA_CLIENT_ID || "",
    clientSecret: process.env.OKTA_CLIENT_SECRET || "",
    authorizeUrl: `${process.env.OKTA_ISSUER || ""}/v1/authorize`,
    tokenUrl: `${process.env.OKTA_ISSUER || ""}/v1/token`,
    userInfoUrl: `${process.env.OKTA_ISSUER || ""}/v1/userinfo`,
    scopes: ["openid", "email", "profile"],
    emailClaim: "email",
    domainClaim: "email",
  },
  github: {
    clientId: process.env.GITHUB_CLIENT_ID || "",
    clientSecret: process.env.GITHUB_CLIENT_SECRET || "",
    authorizeUrl: "https://github.com/login/oauth/authorize",
    tokenUrl: "https://github.com/login/oauth/access_token",
    userInfoUrl: "https://api.github.com/user",
    scopes: ["read:user", "user:email"],
    emailClaim: "email",
  },
};

const ADMIN_ALLOWED_DOMAINS = (process.env.ADMIN_ALLOWED_DOMAINS || "")
  .split(",")
  .map((d) => d.trim().toLowerCase())
  .filter(Boolean);

const OIDC_STATE_COOKIE = "oidc_state";
const OIDC_STATE_TTL_MS = 10 * 60 * 1000;

function isAllowedAdminEmail(email: string | undefined | null): boolean {
  if (!email) return false;
  const normalized = email.trim().toLowerCase();
  if (ADMIN_ALLOWED_DOMAINS.length === 0) return false;
  const domain = normalized.split("@")[1];
  if (!domain) return false;
  return ADMIN_ALLOWED_DOMAINS.includes(domain);
}

function buildAuthorizeUrl(
  provider: OidcProvider,
  redirectUri: string,
  state: string,
): string {
  const cfg = OIDC_PROVIDERS[provider];
  const params = new URLSearchParams({
    client_id: cfg.clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: cfg.scopes.join(" "),
    state,
  });
  if (provider === "google") {
    params.set("access_type", "online");
    params.set("prompt", "select_account");
  }
  return `${cfg.authorizeUrl}?${params.toString()}`;
}

async function exchangeCodeForTokens(
  provider: OidcProvider,
  code: string,
  redirectUri: string,
): Promise<{ accessToken: string; idToken?: string }> {
  const cfg = OIDC_PROVIDERS[provider];
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: redirectUri,
    client_id: cfg.clientId,
    client_secret: cfg.clientSecret,
  });

  const resp = await fetch(cfg.tokenUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body: body.toString(),
  });

  if (!resp.ok) {
    throw new Error(`Token exchange failed with status ${resp.status}`);
  }

  const json = (await resp.json()) as {
    access_token?: string;
    id_token?: string;
    error?: string;
  };

  if (!json.access_token) {
    throw new Error(json.error || "No access_token returned from provider");
  }

  return { accessToken: json.access_token, idToken: json.id_token };
}

async function fetchUserInfo(
  provider: OidcProvider,
  accessToken: string,
): Promise<{ email?: string; name?: string; sub?: string; hd?: string }> {
  const cfg = OIDC_PROVIDERS[provider];
  const resp = await fetch(cfg.userInfoUrl, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: "application/json",
      "User-Agent": "stellar-admin-sso",
    },
  });

  if (!resp.ok) {
    throw new Error(`UserInfo fetch failed with status ${resp.status}`);
  }

  const json = (await resp.json()) as {
    email?: string;
    name?: string;
    login?: string;
    sub?: string;
    id?: number;
    hd?: string;
  };

  return {
    email: json.email,
    name: json.name || json.login,
    sub: json.sub || (json.id !== undefined ? String(json.id) : undefined),
    hd: json.hd,
  };
}

function setAdminSessionCookie(
  res: express.Response,
  name: string,
  value: string,
  maxAgeMs: number,
): void {
  res.cookie(name, value, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "strict",
    path: "/",
    maxAge: maxAgeMs,
  });
}

function clearAdminSessionCookie(res: express.Response, name: string): void {
  res.clearCookie(name, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "strict",
    path: "/",
  });
}

const ADMIN_ACCESS_COOKIE = "admin_access_token";
const ADMIN_REFRESH_COOKIE = "admin_refresh_token";
const ADMIN_ACCESS_TTL_MS = 15 * 60 * 1000;
const ADMIN_REFRESH_TTL_MS = 7 * 24 * 60 * 60 * 1000;

router.post(
  "/login",
  bruteForceGuard,
  async (
    req: express.Request,
    res: express.Response,
  ): Promise<void> => {
    try {
      const { email, password } = req.body as { email?: string; password?: string };

      if (!email || !password) {
        res.status(400).json({
          success: false,
          error: {
            code: "MISSING_CREDENTIALS",
            message: "Email and password are required",
          },
        });
        return;
      }

      const relayer = await prisma.relayer.findUnique({
        where: { email },
      });

      const clientIp = req.ip || "unknown";

      if (!relayer || !relayer.passwordHash) {
        recordFailedAttempt(clientIp);
        await logLoginFailed(
          email,
          clientIp,
          req.headers["user-agent"] || "unknown",
          "User not found or no password set",
        );
        res.status(401).json({
          success: false,
          error: {
            code: "INVALID_CREDENTIALS",
            message: "Invalid email or password",
          },
        });
        return;
      }

      if (!relayer.isActive) {
        recordFailedAttempt(clientIp);
        await logLoginFailed(
          email,
          clientIp,
          req.headers["user-agent"] || "unknown",
          "Account deactivated",
        );
        res.status(403).json({
          success: false,
          error: {
            code: "ACCOUNT_DISABLED",
            message: "Account is disabled",
          },
        });
        return;
      }

      const isValid = await verifyPassword(password, relayer.passwordHash);

      if (!isValid) {
        recordFailedAttempt(clientIp);
        await logLoginFailed(
          email,
          clientIp,
          req.headers["user-agent"] || "unknown",
          "Invalid password",
        );
        res.status(401).json({
          success: false,
          error: {
            code: "INVALID_CREDENTIALS",
            message: "Invalid email or password",
          },
        });
        return;
      }

      // Successful auth — clear any brute-force counters for this IP
      clearBruteForceRecord(clientIp);

      const sessionId = crypto.randomUUID();
      const token = generateToken({
        userId: relayer.id,
        email: relayer.email!,
        role: relayer.role || "VIEWER",
        sid: sessionId,
      }, "15m");

      const refreshTokenData = generateRefreshToken(relayer.id);
      const sessionUserAgent = req.headers["user-agent"] || "unknown";

      await storeEncryptedSession({
        userId: relayer.id,
        email: relayer.email!,
        role: relayer.role || "VIEWER",
        sid: sessionId,
        ipAddress: clientIp,
        userAgent: sessionUserAgent,
        expiresAt: new Date(Date.now() + 15 * 60 * 1000).toISOString(),
        exp: Math.floor((Date.now() + 15 * 60 * 1000) / 1000),
      }, 15 * 60);

      await createUserSession(
        relayer.id,
        token,
        clientIp,
        sessionUserAgent,
      );

      await prisma.relayer.update({
        where: { id: relayer.id },
        data: { lastLoginAt: new Date() },
      });

      await logLoginSuccess(
        relayer.id,
        clientIp,
        req.headers["user-agent"] || "unknown",
      );

      setAdminSessionCookie(res, ADMIN_ACCESS_COOKIE, token, ADMIN_ACCESS_TTL_MS);
      setAdminSessionCookie(
        res,
        ADMIN_REFRESH_COOKIE,
        refreshTokenData.token,
        ADMIN_REFRESH_TTL_MS,
      );

      res.json({
        success: true,
        data: {
          token,
          refreshToken: refreshTokenData.token,
          user: {
            id: relayer.id,
            email: relayer.email,
            name: relayer.name,
            role: relayer.role,
            lastLoginAt: relayer.lastLoginAt,
          },
        },
      });
    } catch (error) {
      console.error("[AUTH] Login error:", error);
      res.status(500).json({
        success: false,
        error: {
          code: "INTERNAL_ERROR",
          message: "An error occurred during login",
        },
      });
    }
  },
);

router.post(
  "/logout",
  async (
    req: express.Request,
    res: express.Response,
  ): Promise<void> => {
    try {
      const authHeader = req.headers.authorization;

      if (!authHeader?.startsWith("Bearer ")) {
        res.status(401).json({
          success: false,
          error: {
            code: "MISSING_TOKEN",
            message: "Authorization token required",
          },
        });
        return;
      }

      const token = authHeader.substring(7);

      await invalidateSession(token);
      await revokeSessionByToken(token);

      clearAdminSessionCookie(res, ADMIN_ACCESS_COOKIE);
      clearAdminSessionCookie(res, ADMIN_REFRESH_COOKIE);

      const userId = (req as any).user?.userId;

      if (userId) {
        await logLogout(
          userId,
          req.ip || "unknown",
          req.headers["user-agent"] || "unknown",
        );
      }

      res.json({
        success: true,
        message: "Logged out successfully",
      });
    } catch (error) {
      console.error("[AUTH] Logout error:", error);
      res.status(500).json({
        success: false,
        error: {
          code: "INTERNAL_ERROR",
          message: "An error occurred during logout",
        },
      });
    }
  },
);

router.post(
  "/refresh",
  async (req: express.Request, res: express.Response): Promise<void> => {
    try {
      const { refreshToken } = req.body as { refreshToken?: string };
      if (!refreshToken) {
        res.status(400).json({
          success: false,
          error: { code: "MISSING_TOKEN", message: "Refresh token is required" },
        });
        return;
      }

      const decoded = verifyRefreshToken(refreshToken);
      if (!decoded) {
        res.status(401).json({
          success: false,
          error: { code: "INVALID_TOKEN", message: "Invalid or expired refresh token" },
        });
        return;
      }

      const isBlacklisted = await isRefreshTokenBlacklisted(decoded.jti);
      if (isBlacklisted) {
        res.status(401).json({
          success: false,
          error: { code: "TOKEN_REVOKED", message: "Refresh token has been revoked" },
        });
        return;
      }

      const relayer = await prisma.relayer.findUnique({
        where: { id: decoded.userId },
      });

      if (!relayer || !relayer.isActive) {
        res.status(401).json({
          success: false,
          error: { code: "USER_INVALID", message: "User not found or disabled" },
        });
        return;
      }

      const expiresInSec = decoded.exp ? decoded.exp - Math.floor(Date.now() / 1000) : 7 * 24 * 60 * 60;
      if (expiresInSec > 0) {
        await blacklistRefreshToken(decoded.jti, expiresInSec);
      }

      const accessToken = generateToken({
        userId: relayer.id,
        email: relayer.email!,
        role: relayer.role || "VIEWER",
      }, "15m");

      const newRefreshTokenData = generateRefreshToken(relayer.id);

      setAdminSessionCookie(res, ADMIN_ACCESS_COOKIE, accessToken, ADMIN_ACCESS_TTL_MS);
      setAdminSessionCookie(
        res,
        ADMIN_REFRESH_COOKIE,
        newRefreshTokenData.token,
        ADMIN_REFRESH_TTL_MS,
      );

      res.json({
        success: true,
        data: {
          accessToken,
          refreshToken: newRefreshTokenData.token,
        },
      });

    } catch (error) {
      console.error("[AUTH] Refresh error:", error);
      res.status(500).json({
        success: false,
        error: { code: "INTERNAL_ERROR", message: "An error occurred during token refresh" },
      });
    }
  }
);

// ── OIDC / OAuth2 SSO Routes ─────────────────────────────────────────────────
router.get(
  "/oidc/:provider/start",
  async (req: express.Request, res: express.Response): Promise<void> => {
    try {
      const provider = req.params.provider as OidcProvider;
      if (!OIDC_PROVIDERS[provider]) {
        res.status(400).json({
          success: false,
          error: { code: "UNSUPPORTED_PROVIDER", message: "Unsupported OIDC provider" },
        });
        return;
      }

      const cfg = OIDC_PROVIDERS[provider];
      if (!cfg.clientId || !cfg.clientSecret) {
        res.status(503).json({
          success: false,
          error: { code: "PROVIDER_NOT_CONFIGURED", message: "Provider is not configured" },
        });
        return;
      }

      const state = crypto.randomBytes(32).toString("hex");
      const redirectUri =
        (req.query.redirect_uri as string) ||
        `${req.protocol}://${req.get("host")}/api/auth/oidc/${provider}/callback`;

      setAdminSessionCookie(res, OIDC_STATE_COOKIE, state, OIDC_STATE_TTL_MS);

      const authorizeUrl = buildAuthorizeUrl(provider, redirectUri, state);
      res.json({ success: true, data: { authorizeUrl, state } });
    } catch (error) {
      console.error("[AUTH] OIDC start error:", error);
      res.status(500).json({
        success: false,
        error: { code: "INTERNAL_ERROR", message: "Failed to start OIDC flow" },
      });
    }
  },
);

router.get(
  "/oidc/:provider/callback",
  async (req: express.Request, res: express.Response): Promise<void> => {
    try {
      const provider = req.params.provider as OidcProvider;
      const cfg = OIDC_PROVIDERS[provider];
      if (!cfg) {
        res.status(400).json({
          success: false,
          error: { code: "UNSUPPORTED_PROVIDER", message: "Unsupported OIDC provider" },
        });
        return;
      }

      const { code, state } = req.query as { code?: string; state?: string };
      const expectedState = req.cookies?.[OIDC_STATE_COOKIE];

      clearAdminSessionCookie(res, OIDC_STATE_COOKIE);

      if (!code || !state || !expectedState || state !== expectedState) {
        res.status(401).json({
          success: false,
          error: { code: "INVALID_STATE", message: "OIDC state validation failed" },
        });
        return;
      }

      const redirectUri =
        (req.query.redirect_uri as string) ||
        `${req.protocol}://${req.get("host")}/api/auth/oidc/${provider}/callback`;

      const { accessToken: providerAccessToken } = await exchangeCodeForTokens(
        provider,
        code,
        redirectUri,
      );

      const profile = await fetchUserInfo(provider, providerAccessToken);

      if (!isAllowedAdminEmail(profile.email)) {
        const clientIp = req.ip || "unknown";
        await logLoginFailed(
          profile.email || "unknown",
          clientIp,
          req.headers["user-agent"] || "unknown",
          `OIDC domain not authorized (${provider})`,
        );
        res.status(403).json({
          success: false,
          error: {
            code: "DOMAIN_NOT_AUTHORIZED",
            message: "Account domain is not authorized for admin access",
          },
        });
        return;
      }

      const email = profile.email!.trim().toLowerCase();
      let relayer = await prisma.relayer.findUnique({ where: { email } });

      if (!relayer) {
        relayer = await prisma.relayer.create({
          data: {
            email,
            name: profile.name || email,
            role: "ADMIN",
            isActive: true,
          },
        });
      }

      if (!relayer.isActive) {
        res.status(403).json({
          success: false,
          error: { code: "ACCOUNT_DISABLED", message: "Account is disabled" },
        });
        return;
      }

      const sessionId = crypto.randomUUID();
      const clientIp = req.ip || "unknown";
      const userAgent = req.headers["user-agent"] || "unknown";

      const token = generateToken(
        {
          userId: relayer.id,
          email: relayer.email!,
          role: relayer.role || "ADMIN",
          sid: sessionId,
        },
        "15m",
      );

      const refreshTokenData = generateRefreshToken(relayer.id);

      await storeEncryptedSession(
        {
          userId: relayer.id,
          email: relayer.email!,
          role: relayer.role || "ADMIN",
          sid: sessionId,
          ipAddress: clientIp,
          userAgent,
          expiresAt: new Date(Date.now() + ADMIN_ACCESS_TTL_MS).toISOString(),
          exp: Math.floor((Date.now() + ADMIN_ACCESS_TTL_MS) / 1000),
        },
        15 * 60,
      );

      await createUserSession(relayer.id, token, clientIp, userAgent);

      await prisma.relayer.update({
        where: { id: relayer.id },
        data: { lastLoginAt: new Date() },
      });

      await logLoginSuccess(relayer.id, clientIp, userAgent);

      setAdminSessionCookie(res, ADMIN_ACCESS_COOKIE, token, ADMIN_ACCESS_TTL_MS);
      setAdminSessionCookie(
        res,
        ADMIN_REFRESH_COOKIE,
        refreshTokenData.token,
        ADMIN_REFRESH_TTL_MS,
      );

      res.json({
        success: true,
        data: {
          token,
          refreshToken: refreshTokenData.token,
          user: {
            id: relayer.id,
            email: relayer.email,
            name: relayer.name,
            role: relayer.role,
          },
        },
      });
    } catch (error) {
      console.error("[AUTH] OIDC callback error:", error);
      res.status(500).json({
        success: false,
        error: { code: "INTERNAL_ERROR", message: "OIDC callback failed" },
      });
    }
  },
);

// ── Web3 Challenge Nonce Generation Route (Issue #749) ───────────────────────
const handleNonceGeneration = async (req: express.Request, res: express.Response): Promise<void> => {
  try {
    const publicKey = (req.query.publicKey || req.body.publicKey || "anonymous") as string;
    const nonce = `sf_nonce_${crypto.randomUUID()}`;
    const ttlSeconds = 300; // 5 minutes
    const expiresAt = new Date(Date.now() + ttlSeconds * 1000).toISOString();

    res.json({
      success: true,
      data: {
        nonce,
        publicKey,
        expiresAt,
      },
    });
  } catch (error) {
    console.error("[AUTH] Nonce generation error:", error);
    res.status(500).json({
      success: false,
      error: { code: "INTERNAL_ERROR", message: "Failed to generate challenge nonce" },
    });
  }
};

router.get("/nonce", handleNonceGeneration);
router.post("/nonce", handleNonceGeneration);

// ── Web3 Signature Validation & JWT Issuance Route (Issue #749) ──────────────
const handleVerifySignature = async (req: express.Request, res: express.Response): Promise<void> => {
  try {
    const { publicKey, signature, nonce } = req.body as {
      publicKey?: string;
      signature?: string;
      nonce?: string;
    };

    if (!publicKey || !signature || !nonce) {
      res.status(400).json({
        success: false,
        error: {
          code: "MISSING_CREDENTIALS",
          message: "publicKey, signature, and nonce are required",
        },
      });
      return;
    }

    // 1. Validate Stellar public key syntax
    let keypair: Keypair;
    try {
      keypair = Keypair.fromPublicKey(publicKey.trim());
    } catch {
      res.status(400).json({
        success: false,
        error: {
          code: "INVALID_PUBLIC_KEY",
          message: "Provided public key is not a valid Stellar Ed25519 address",
        },
      });
      return;
    }

    // 2. Anti-replay check & single-use nonce consumption
    const isNonceValid = await cryptographicNonceStore.consume(publicKey.trim(), nonce.trim());
    if (!isNonceValid) {
      res.status(401).json({
        success: false,
        error: {
          code: "INVALID_NONCE",
          message: "Nonce is invalid, expired, or has already been used",
        },
      });
      return;
    }

    // 3. Verify Ed25519 signature
    const cleanSigHex = normalizeHexString(signature);
    let signatureBytes: Buffer;
    try {
      signatureBytes = Buffer.from(cleanSigHex, "hex");
      if (signatureBytes.length !== 64) {
        // Try base64 decoding if hex length is not 64 bytes
        signatureBytes = Buffer.from(signature.trim(), "base64");
      }
    } catch {
      signatureBytes = Buffer.from(cleanSigHex, "hex");
    }

    const messageBytes = Buffer.from(nonce.trim(), "utf-8");
    const isSigValid = keypair.verify(messageBytes, signatureBytes);

    if (!isSigValid) {
      res.status(401).json({
        success: false,
        error: {
          code: "INVALID_SIGNATURE",
          message: "Stellar Web3 signature verification failed",
        },
      });
      return;
    }

    // 4. Look up or register relayer / admin user for this public key
    let relayer = await prisma.relayer.findFirst({
      where: { apiKey: publicKey.trim() },
    });

    const userEmail = `${publicKey.trim().substring(0, 12)}@stellar.wallet`;
    const userRole = relayer?.role || "ADMIN";
    const userId = relayer?.id || 9999;

    // 5. Issue short-lived JWT access token (15m expiry) and refresh token
    const accessToken = generateToken(
      {
        userId,
        email: userEmail,
        role: userRole,
      },
      "15m",
    );

    const refreshTokenData = generateRefreshToken(userId);

    const clientIp = req.ip || "unknown";
    await logLoginSuccess(userId, clientIp, req.headers["user-agent"] || "unknown");

    res.json({
      success: true,
      data: {
        token: accessToken,
        accessToken,
        refreshToken: refreshTokenData.token,
        user: {
          id: userId,
          publicKey: publicKey.trim(),
          email: userEmail,
          role: userRole,
        },
      },
    });
  } catch (error) {
    console.error("[AUTH] Verify signature error:", error);
    res.status(500).json({
      success: false,
      error: { code: "INTERNAL_ERROR", message: "Error verifying Web3 signature" },
    });
  }
};

router.post("/verify-signature", handleVerifySignature);
router.post("/web3", handleVerifySignature);
router.post("/web3-login", handleVerifySignature);

export default router;