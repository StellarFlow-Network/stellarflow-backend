import jwt from "jsonwebtoken";
import bcrypt from "bcryptjs";
import crypto from "crypto";
import { prisma } from "../lib/prisma.js";
import { getRedisClient } from "../lib/redis.js";

export interface JwtPayload {
  userId: number;
  email: string;
  role: string;
  group?: string;
  permissions?: string[];
  iat?: number;
  exp?: number;
}

export function getJwtSecret(): string {
  const secret = process.env.JWT_SECRET;
  if (!secret) {
    throw new Error("JWT_SECRET not configured");
  }
  return secret;
}

export function getJwtExpiryHours(): number {
  const hours = process.env.JWT_EXPIRY_HOURS;
  if (!hours) return 24;
  const parsed = parseInt(hours, 10);
  return isNaN(parsed) ? 24 : parsed;
}

export function generateToken(payload: Omit<JwtPayload, "iat" | "exp">, expiresIn?: string): string {
  const secret = getJwtSecret();
  const expiryHours = getJwtExpiryHours();

  return jwt.sign(payload, secret, {
    expiresIn: expiresIn || `${expiryHours}h`,
  });
}

export function verifyToken(token: string): JwtPayload | null {
  try {
    const secret = getJwtSecret();
    const decoded = jwt.verify(token, secret) as JwtPayload;
    return decoded;
  } catch {
    return null;
  }
}

export async function hashPassword(password: string): Promise<string> {
  const saltRounds = 10;
  return bcrypt.hash(password, saltRounds);
}

export async function verifyPassword(
  password: string,
  hash: string,
): Promise<boolean> {
  return bcrypt.compare(password, hash);
}

export async function createUserSession(
  relayerId: number,
  token: string,
  ipAddress: string,
  userAgent: string,
): Promise<void> {
  const expiryHours = getJwtExpiryHours();
  const expiresAt = new Date();
  expiresAt.setHours(expiresAt.getHours() + expiryHours);

  await prisma.userSession.create({
    data: {
      relayerId,
      token,
      ipAddress,
      userAgent,
      expiresAt,
      isActive: true,
    },
  });
}

export async function invalidateSession(token: string): Promise<void> {
  await prisma.userSession.updateMany({
    where: { token, isActive: true },
    data: { isActive: false },
  });
}

export async function getActiveSession(
  token: string,
): Promise<{ relayerId: number; expiresAt: Date } | null> {
  const session = await prisma.userSession.findFirst({
    where: { token, isActive: true },
    select: { relayerId: true, expiresAt: true },
  });

  if (!session) return null;

  if (new Date() > session.expiresAt) {
    await invalidateSession(token);
    return null;
  }

  return session;
}

export async function cleanupExpiredSessions(): Promise<number> {
  const result = await prisma.userSession.updateMany({
    where: { expiresAt: { lt: new Date() } },
    data: { isActive: false },
  });
  return result.count;
}

export interface RefreshTokenPayload {
  userId: number;
  jti: string;
  iat?: number;
  exp?: number;
}

export function generateRefreshToken(userId: number): { token: string, jti: string, expiresInSec: number } {
  const secret = getJwtSecret();
  const jti = crypto.randomUUID();
  const expiresInSec = 7 * 24 * 60 * 60; // 7 days
  const token = jwt.sign({ userId, jti }, secret, { expiresIn: expiresInSec });
  return { token, jti, expiresInSec };
}

export function verifyRefreshToken(token: string): RefreshTokenPayload | null {
  try {
    const secret = getJwtSecret();
    const decoded = jwt.verify(token, secret) as RefreshTokenPayload;
    if (!decoded.jti) return null;
    return decoded;
  } catch {
    return null;
  }
}

const BLACKLIST_PREFIX = "token_blacklist:";

export async function blacklistRefreshToken(jti: string, expiresInSec: number): Promise<void> {
  const redis = getRedisClient();
  if (!redis) {
    console.warn("[Redis] Not connected, cannot blacklist token");
    return;
  }
  await redis.set(`${BLACKLIST_PREFIX}${jti}`, "revoked", { EX: expiresInSec });
}

export async function isRefreshTokenBlacklisted(jti: string): Promise<boolean> {
  const redis = getRedisClient();
  if (!redis) return false;
  const status = await redis.get(`${BLACKLIST_PREFIX}${jti}`);
  return status === "revoked";
}