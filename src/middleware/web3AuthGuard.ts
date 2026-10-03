import { Request, Response, NextFunction } from "express";
import { Keypair } from "@stellar/stellar-sdk";
import { verifyToken, getActiveSession } from "../utils/jwt.js";
import { cryptographicNonceStore } from "../services/nonceStoreService.js";
import { webauthnService } from "../services/webauthnService.js";
import { sendApiError } from "../lib/apiError.js";
import { normalizeHexString } from "./signatureVerificationMiddleware.js";
import nacl from "tweetnacl";

export interface AuthenticatedUser {
  userId?: number;
  email?: string;
  publicKey?: string;
  role: string;
  permissions?: string[];
}

declare global {
  namespace Express {
    interface Request {
      user?: AuthenticatedUser;
      web3Authenticated?: boolean;
      webauthnAuthenticated?: boolean;
    }
  }
}

/**
 * web3AuthGuard
 * 
 * Issue #749: JWT & Web3 Signature Authentication Guard for API Routes
 * Secure administrative and private account endpoints using Web3 wallet signature verification
 * or short-lived JWT access tokens.
 */
export const web3AuthGuard = (allowedRoles: string[] = []) => {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const authHeader = req.headers.authorization;
      const signatureHeader = req.headers["x-stellar-signature"] as string | undefined;
      const publicKeyHeader = req.headers["x-stellar-publickey"] as string | undefined;
      const nonceHeader = req.headers["x-stellar-nonce"] as string | undefined;
      const webauthnCredentialId = req.headers["x-webauthn-credential-id"] as string | undefined;
      const webauthnAuthenticatorData = req.headers["x-webauthn-authenticator-data"] as string | undefined;
      const webauthnClientDataJson = req.headers["x-webauthn-client-data-json"] as string | undefined;
      const webauthnSignature = req.headers["x-webauthn-signature"] as string | undefined;

      // ── Method 1: JWT Bearer Token Authentication ────────────────────────────
      if (authHeader && authHeader.startsWith("Bearer ")) {
        const token = authHeader.substring(7);
        const payload = verifyToken(token);

        if (payload) {
          req.user = {
            userId: payload.userId,
            email: payload.email,
            role: payload.role || "USER",
            permissions: payload.permissions,
          };
          req.web3Authenticated = false;

          if (allowedRoles.length > 0 && !allowedRoles.includes(req.user.role)) {
            res.status(403).json({
              success: false,
              error: {
                code: "FORBIDDEN",
                message: `User role '${req.user.role}' is not authorized for this endpoint`,
              },
            });
            return;
          }

          next();
          return;
        }
      }

      // ── Method 2: Direct Web3 Signature Authentication Header Guard ─────────
      if (signatureHeader && publicKeyHeader && nonceHeader) {
        const publicKey = publicKeyHeader.trim();
        const nonce = nonceHeader.trim();
        const signatureHex = normalizeHexString(signatureHeader);

        // 1. Verify Stellar public key format
        try {
          Keypair.fromPublicKey(publicKey);
        } catch {
          res.status(400).json({
            success: false,
            error: {
              code: "INVALID_PUBLIC_KEY",
              message: "Invalid Stellar public key format",
            },
          });
          return;
        }

        // 2. Anti-replay nonce consumption
        const isNonceValid = await cryptographicNonceStore.consume(publicKey, nonce);
        if (!isNonceValid) {
          res.status(401).json({
            success: false,
            error: {
              code: "INVALID_NONCE",
              message: "Nonce is invalid, expired, or has already been used (replay detected)",
            },
          });
          return;
        }

        // 3. Verify Ed25519 signature
        let isSigValid = false;
        try {
          const keypair = Keypair.fromPublicKey(publicKey);
          const sigBuffer = Buffer.from(signatureHex, "hex");
          const msgBuffer = Buffer.from(nonce, "utf-8");

          isSigValid = keypair.verify(msgBuffer, sigBuffer);
        } catch {
          isSigValid = false;
        }

        if (!isSigValid) {
          res.status(401).json({
            success: false,
            error: {
              code: "INVALID_SIGNATURE",
              message: "Web3 wallet signature verification failed",
            },
          });
          return;
        }

        // Successfully authenticated via Web3 Signature
        req.user = {
          publicKey,
          role: "ADMIN", // Web3 signature authenticated callers get ADMIN access
        };
        req.web3Authenticated = true;

        if (allowedRoles.length > 0 && !allowedRoles.includes(req.user.role)) {
          res.status(403).json({
            success: false,
            error: {
              code: "FORBIDDEN",
              message: "Role authorization failed for Web3 account",
            },
          });
          return;
        }

        next();
        return;
      }

      // ── Method 3: WebAuthn / Passkey Authentication ─────────────────────────
      if (webauthnCredentialId && webauthnAuthenticatorData && webauthnClientDataJson && webauthnSignature) {
        const isAdminRoute = allowedRoles.length === 0 || allowedRoles.includes("ADMIN");

        if (!isAdminRoute) {
          res.status(403).json({
            success: false,
            error: {
              code: "FORBIDDEN",
              message: "WebAuthn authentication is only permitted for administrative endpoints",
            },
          });
          return;
        }

        let verificationResult: { verified: boolean; publicKey?: string; reason?: string };
        try {
          verificationResult = await webauthnService.verifyAssertion({
            credentialId: webauthnCredentialId.trim(),
            authenticatorData: webauthnAuthenticatorData,
            clientDataJson: webauthnClientDataJson,
            signature: webauthnSignature,
          });
        } catch (err) {
          console.error("[web3AuthGuard] WebAuthn verification error:", err);
          verificationResult = { verified: false, reason: "verification_error" };
        }

        if (!verificationResult.verified) {
          res.status(401).json({
            success: false,
            error: {
              code: "INVALID_WEBAUTHN_ASSERTION",
              message: `WebAuthn attestation signature verification failed${
                verificationResult.reason ? `: ${verificationResult.reason}` : ""
              }`,
            },
          });
          return;
        }

        req.user = {
          publicKey: verificationResult.publicKey,
          role: "ADMIN",
        };
        req.web3Authenticated = true;
        req.webauthnAuthenticated = true;

        if (allowedRoles.length > 0 && !allowedRoles.includes(req.user.role)) {
          res.status(403).json({
            success: false,
            error: {
              code: "FORBIDDEN",
              message: "Role authorization failed for WebAuthn account",
            },
          });
          return;
        }

        next();
        return;
      }

      // If neither valid JWT nor valid Web3 signature headers provided:
      res.status(401).json({
        success: false,
        error: {
          code: "UNAUTHORIZED",
          message: "Authentication required. Provide a valid Bearer token, Web3 signature headers (X-Stellar-Signature, X-Stellar-PublicKey, X-Stellar-Nonce), or WebAuthn assertion headers (X-WebAuthn-Credential-Id, X-WebAuthn-Authenticator-Data, X-WebAuthn-Client-Data-Json, X-WebAuthn-Signature)",
        },
      });
    } catch (error) {
      console.error("[web3AuthGuard] Authentication error:", error);
      res.status(500).json({
        success: false,
        error: {
          code: "INTERNAL_AUTH_ERROR",
          message: "An internal error occurred during authentication",
        },
      });
    }
  };
};

export default web3AuthGuard;
