import { prisma } from "../lib/prisma.js";
import {
  generateToken,
  verifyPassword,
  createUserSession,
  invalidateSession,
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

      const token = generateToken({
        userId: relayer.id,
        email: relayer.email!,
        role: relayer.role || "VIEWER",
      });

      await createUserSession(
        relayer.id,
        token,
        clientIp,
        req.headers["user-agent"] || "unknown",
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

export default router;