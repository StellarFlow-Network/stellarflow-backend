import { NextFunction, Request, Response } from "express";

let hasWarnedAboutMissingAdminControls = false;

function getHeaderValue(
  value: string | string[] | undefined,
): string | undefined {
  if (Array.isArray(value)) {
    return value[0];
  }

  return value;
}

function matchesAdminIp(requestIp: string | undefined, adminIp: string): boolean {
  if (!requestIp) {
    return false;
  }

  return requestIp === adminIp || requestIp === `::ffff:${adminIp}`;
}

export const adminMiddleware = (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  const configuredAdminKey = process.env.ADMIN_API_KEY;
  const requestAdminKey = getHeaderValue(req.headers["x-admin-key"]);

  if (configuredAdminKey && requestAdminKey !== configuredAdminKey) {
    return res.status(403).json({
      success: false,
      error: "Invalid or missing admin API key",
    });
  }

  const configuredAdminIp = process.env.ADMIN_IP;
  if (configuredAdminIp && !matchesAdminIp(req.ip, configuredAdminIp)) {
    return res.status(403).json({
      success: false,
      error: "Admin access denied for this IP address",
    });
  }

  if (
    !configuredAdminKey &&
    !configuredAdminIp &&
    !hasWarnedAboutMissingAdminControls
  ) {
    hasWarnedAboutMissingAdminControls = true;
    console.warn(
      "[AdminMiddleware] ADMIN_API_KEY and ADMIN_IP are not configured. Admin routes are protected only by the shared API key.",
    );
  }

  next();
};
