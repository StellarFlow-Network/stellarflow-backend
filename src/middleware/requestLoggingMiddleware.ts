import { NextFunction, Request, Response } from "express";
import { logger } from "../utils/logger";

export function requestLoggingMiddleware(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  const startTime = Date.now();

  logger.info("Incoming HTTP request", {
    method: req.method,
    path: req.originalUrl || req.url,
    ip: req.ip,
    requestId: req.requestId,
  });

  res.on("finish", () => {
    const durationMs = Date.now() - startTime;
    logger.info("HTTP response completed", {
      method: req.method,
      path: req.originalUrl || req.url,
      statusCode: res.statusCode,
      durationMs,
      requestId: req.requestId,
    });
  });

  next();
}
