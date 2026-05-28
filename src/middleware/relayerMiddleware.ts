import { Request, Response, NextFunction } from "express";
import prisma from "../lib/prisma";
import { getEmptyRelayer, type ActiveRelayer, type Relayer } from "../types/relayer.types";

/**
 * Relayer middleware: Attempts to authenticate a request using an API key
 * and attach relayer metadata to req.relayer.
 *
 * If authentication fails or no relayer matches the API key, req.relayer is set
 * to an EmptyRelayer instance instead of undefined. This eliminates the
 * architectural noise of null/undefined checks downstream.
 *
 * This middleware should run after API key extraction but before
 * relayer-specific authorization checks.
 */
export const relayerMiddleware = async (
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  // Attempt to extract API key from header
  const apiKey = req.headers["x-api-key"];

  if (!apiKey || typeof apiKey !== "string" || apiKey.trim() === "") {
    // No API key provided — set empty relayer
    req.relayer = getEmptyRelayer();
    return next();
  }

  try {
    // Look up relayer by API key
    const relayerData = await prisma.relayer.findFirst({
      where: {
        apiKey: apiKey.trim(),
        isActive: true,
      },
      select: {
        id: true,
        name: true,
        allowedAssets: true,
        publicKey: true,
      },
    });

    if (relayerData) {
      // Relayer found — attach to request with is_noop() method
      const activeRelayer: ActiveRelayer = {
        id: relayerData.id,
        name: relayerData.name,
        allowedAssets: relayerData.allowedAssets,
        publicKey: relayerData.publicKey,
        is_noop(): boolean {
          return false;
        },
      };
      req.relayer = activeRelayer;
    } else {
      // API key doesn't match any relayer — use empty relayer
      req.relayer = getEmptyRelayer();
    }
  } catch (error) {
    console.error("[RelayerMiddleware] Error looking up relayer:", error);
    // On DB error, default to empty relayer to avoid breaking the request
    req.relayer = getEmptyRelayer();
  }

  next();
};
