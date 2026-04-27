import { Request, Response, NextFunction } from "express";
import { ipWhitelistService, VIPRequestContext } from "../services/ipWhitelist.service";

// Extend Express Request to include VIP context
declare global {
  namespace Express {
    interface Request {
      vipContext?: VIPRequestContext;
    }
  }
}

/**
 * VIP Pool Middleware
 * Checks if the request comes from a whitelisted institutional IP
 * and attaches VIP context to the request for priority handling
 */
export const vipPoolMiddleware = async (
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    // Get client IP from various sources
    const clientIP =
      (req.headers["x-forwarded-for"] as string)?.split(",")[0] ||
      (req.headers["x-real-ip"] as string) ||
      req.socket.remoteAddress ||
      "unknown";

    // Check if IP is in VIP whitelist
    const vipContext = await ipWhitelistService.checkIP(clientIP);

    // Attach VIP context to request
    req.vipContext = vipContext;

    // Add VIP headers to response for debugging (only in development)
    if (process.env.NODE_ENV !== "production") {
      res.setHeader("X-VIP-Status", vipContext.isVIP ? "true" : "false");
      if (vipContext.isVIP) {
        res.setHeader("X-VIP-Priority", vipContext.priority.toString());
        res.setHeader(
          "X-VIP-RateLimit",
          vipContext.customRateLimit.toString()
        );
      }
    }

    // Log VIP requests for monitoring
    if (vipContext.isVIP) {
      console.log(
        `[VIP Pool] ${vipContext.entry?.label} (${clientIP}) - Priority: ${vipContext.priority}`
      );
    }

    next();
  } catch (error) {
    // If VIP check fails, continue with default (non-VIP) context
    console.error("[VIP Pool] Error checking IP whitelist:", error);
    req.vipContext = {
      isVIP: false,
      customRateLimit: 100,
      priority: 0,
    };
    next();
  }
};

/**
 * Rate Limit Middleware (VIP-aware)
 * Applies different rate limits based on VIP status
 * This is a simple implementation - for production, consider using express-rate-limit
 */
export const rateLimitMiddleware = (
  req: Request,
  res: Response,
  next: NextFunction
): void => {
  const vipContext = req.vipContext;

  if (!vipContext) {
    // VIP middleware hasn't run yet
    return next();
  }

  const clientIP =
    (req.headers["x-forwarded-for"] as string)?.split(",")[0] ||
    req.socket.remoteAddress ||
    "unknown";

  // Simple in-memory rate limiting (for production, use Redis or similar)
  const rateLimitKey = clientIP;
  const rateLimit = vipContext.customRateLimit;

  // This is a placeholder - implement actual rate limiting logic
  // For now, we just attach the rate limit info to the response
  res.setHeader("X-RateLimit-Limit", rateLimit.toString());

  // VIP users get priority processing
  if (vipContext.isVIP) {
    // Skip any additional throttling for VIP users
    return next();
  }

  // Apply normal rate limiting for non-VIP users
  // TODO: Implement actual rate limiting with request counting
  next();
};

/**
 * VIP-Only Middleware
 * Restricts endpoint access to whitelisted IPs only
 */
export const vipOnlyMiddleware = (
  req: Request,
  res: Response,
  next: NextFunction
): void => {
  const vipContext = req.vipContext;

  if (!vipContext || !vipContext.isVIP) {
    res.status(403).json({
      success: false,
      error: "Access denied. This endpoint is restricted to VIP institutions only.",
    });
    return;
  }

  next();
};
