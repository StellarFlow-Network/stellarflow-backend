/**
 * Brute-force protection for authentication endpoints.
 *
 * Tracks failed /auth/verify attempts per IP and per wallet address.
 * After MAX_ATTEMPTS failures within WINDOW_MS, the IP/wallet is temporarily
 * blocked for BLOCK_DURATION_MS. Block events are logged and alerted.
 */

import { Request, Response, NextFunction } from "express";
import { logger } from "../utils/logger.js";

const MAX_ATTEMPTS = 5;
const WINDOW_MS = 10 * 60 * 1000; // 10 minutes
const BLOCK_DURATION_MS = 15 * 60 * 1000; // 15 minutes

interface AttemptRecord {
  count: number;
  windowStart: number;
  blockedUntil?: number;
}

// In-memory stores — keyed by IP and by wallet address
const ipAttempts = new Map<string, AttemptRecord>();
const walletAttempts = new Map<string, AttemptRecord>();

function resolveIp(req: Request): string {
  const forwarded = req.headers["x-forwarded-for"];
  if (forwarded) {
    const raw = Array.isArray(forwarded) ? forwarded[0] : forwarded.split(",")[0];
    return raw?.trim() ?? req.ip ?? "unknown";
  }
  return req.ip ?? req.socket?.remoteAddress ?? "unknown";
}

function isBlocked(record: AttemptRecord | undefined): boolean {
  if (!record) return false;
  if (record.blockedUntil && Date.now() < record.blockedUntil) return true;
  return false;
}

function incrementAttempts(store: Map<string, AttemptRecord>, key: string): AttemptRecord {
  const now = Date.now();
  let record = store.get(key);

  if (!record || now - record.windowStart > WINDOW_MS) {
    // Start a fresh window
    record = { count: 1, windowStart: now };
  } else {
    record.count += 1;
  }

  if (record.count >= MAX_ATTEMPTS) {
    record.blockedUntil = now + BLOCK_DURATION_MS;
  }

  store.set(key, record);
  return record;
}

/**
 * Call this after a successful auth to clear the failure counters.
 */
export function clearBruteForceRecord(ip: string, wallet?: string): void {
  ipAttempts.delete(ip);
  if (wallet) walletAttempts.delete(wallet);
}

/**
 * Call this on every failed auth attempt to record and potentially block.
 * Returns true if the caller is now blocked.
 */
export function recordFailedAttempt(ip: string, wallet?: string): boolean {
  const ipRecord = incrementAttempts(ipAttempts, ip);

  if (wallet) {
    const walletRecord = incrementAttempts(walletAttempts, wallet);
    if (walletRecord.blockedUntil) {
      logger.warn("[BruteForce] Wallet blocked after repeated failures", {
        wallet,
        attempts: walletRecord.count,
        blockedUntilMs: walletRecord.blockedUntil,
      });
    }
  }

  if (ipRecord.blockedUntil) {
    logger.warn("[BruteForce] IP blocked after repeated failures", {
      ip,
      attempts: ipRecord.count,
      blockedUntilMs: ipRecord.blockedUntil,
    });
    return true;
  }

  return false;
}

/**
 * Express middleware that rejects requests from blocked IPs or wallets
 * before they reach the auth handler.
 *
 * Attach to /auth/sep10 and /auth/verify routes.
 */
export function bruteForceGuard(req: Request, res: Response, next: NextFunction): void {
  const ip = resolveIp(req);
  // Wallet may be in body (verify) or query (sep10 challenge)
  const wallet: string | undefined =
    (req.body as Record<string, string>)?.wallet ??
    (req.query as Record<string, string>)?.account;

  const ipRecord = ipAttempts.get(ip);
  const walletRecord = wallet ? walletAttempts.get(wallet) : undefined;

  if (isBlocked(ipRecord) || isBlocked(walletRecord)) {
    const retryAfterSec = Math.ceil(BLOCK_DURATION_MS / 1000);
    logger.warn("[BruteForce] Blocked request rejected", { ip, wallet });

    res.status(429).json({
      success: false,
      error: {
        code: "BRUTE_FORCE_BLOCKED",
        message:
          "Too many failed attempts. Your IP/wallet has been temporarily blocked for 15 minutes. " +
          "If you believe this is a mistake, please contact support.",
        retryAfter: retryAfterSec,
      },
    });
    return;
  }

  next();
}
