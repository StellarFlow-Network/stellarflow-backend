import { Request, Response, NextFunction } from 'express';

// Allowlisted endpoints that should remain accessible during maintenance
const allowlist = [
  '/status',
  '/health', // Add more paths as needed
];

/**
 * Middleware to enforce maintenance mode.
 * Reads MAINTENANCE_MODE from process.env (set in .env).
 * Returns 503 Service Unavailable for all endpoints except allowlisted ones.
 */
export function maintenanceMiddleware(req: Request, res: Response, next: NextFunction) {
  const isMaintenance = process.env.MAINTENANCE_MODE === 'true';
  // Allow allowlisted endpoints
  if (isMaintenance && !allowlist.includes(req.path)) {
    return res.status(503).json({
      message: 'Service is under maintenance. Please try again later.',
      maintenance: true,
    });
  }
  next();
}