import { Request, Response, NextFunction } from "express";
import { sendApiError } from "../lib/apiError.js";

// Allowlisted endpoints that should remain accessible during maintenance
const allowlist = [
  "/status",
  "/health", // Add more paths as needed
];

/**
 * Middleware to enforce maintenance mode.
 * Reads MAINTENANCE_MODE from process.env (set in .env).
 * Returns 503 Service Unavailable for all endpoints except allowlisted ones.
 */
export function maintenanceMiddleware(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  const isMaintenance = process.env.MAINTENANCE_MODE === "true";
  // Allow allowlisted endpoints
  const allowed = allowlist.some(
    (path) => req.path === path || req.path.startsWith(`${path}/`),
  );
  if (isMaintenance && !allowed) {
    sendApiError(res, 503, "MAINTENANCE_MODE");
    return;
  }
  next();
}
