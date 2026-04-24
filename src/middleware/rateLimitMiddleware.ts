import { rateLimit } from "express-rate-limit";
import { Request } from "express";

/**
 * Rate limiting middleware to protect the API from DoS attacks.
 * Limits each IP address to 100 requests per 15 minutes.
 * Exempts the "Admin" IP if configured in the environment.
 */
export const rateLimitMiddleware = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100, // Limit each IP to 100 requests per `window` (here, per 15 minutes)
  standardHeaders: true, // Return rate limit info in the `RateLimit-*` headers
  legacyHeaders: false, // Disable the `X-RateLimit-*` headers
  message: {
    success: false,
    error: "Too many requests from this IP, please try again after 15 minutes",
  },
  skip: (req: Request) => {
    const adminIp = process.env.ADMIN_IP;
    // Skip rate limiting if the request IP matches the ADMIN_IP
    return !!adminIp && req.ip === adminIp;
  },
});
