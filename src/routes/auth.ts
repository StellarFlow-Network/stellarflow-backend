import { prisma } from "../lib/prisma.js";
import { Keypair } from "@stellar/stellar-sdk";
import crypto from "crypto";
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