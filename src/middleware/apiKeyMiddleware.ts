import { Request, Response, NextFunction } from "express";
import prisma from "../lib/prisma";

export const apiKeyMiddleware = async (
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  // Short-circuit if already authenticated by a previous middleware instance
  if (req.relayer) {
    next();
    return;
  }

  const apiKey = req.headers["x-api-key"];

  if (typeof apiKey !== "string" || apiKey.length === 0) {
    res.status(401).json({
      success: false,
      error: "Invalid or missing API key",
    });
    return;
  }

  try {
    // 1. Try to find an active relayer with this API key
    const relayer = await prisma.relayer.findFirst({
      where: {
        apiKey,
        isActive: true,
      },
    });

    if (relayer) {
      req.relayer = {
        id: relayer.id,
        name: relayer.name,
        allowedAssets: relayer.allowedAssets,
      };
      next();
      return;
    }

    // 2. Fall back to global API key for backward compatibility
    const expectedKey = process.env.API_KEY;

    if (!expectedKey) {
      console.error("Critical: API_KEY not set in environment");
      res.status(500).json({
        success: false,
        error: "Authentication configuration error",
      });
      return;
    }

    if (apiKey === expectedKey) {
      next();
      return;
    }

    res.status(401).json({
      success: false,
      error: "Invalid or missing API key",
    });
  } catch (error) {
    console.error("[apiKeyMiddleware] Error during authentication:", error);
    res.status(500).json({
      success: false,
      error: "Authentication check failed",
    });
  }
};
