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
  sid?: string;
  sessionId?: string;
  iat?: number;
  exp?: number;
}

export interface SessionRedisRecord {
  userId: number;
  email: string;
  role: string;
  sid: string;
  sessionId?: string;
  group?: string;
  permissions?: string[];
  ipAddress?: string;
  userAgent?: string;
  createdAt?: string;
  expiresAt?: string;
  exp?: number;
}

const SESSION_PREFIX = "stellarflow:sessions:";
const SESSION_REVOCATION_PREFIX = "stellarflow:session:revoked:";
const SESSION_FALLBACK_STORE = new Map<string, { value: string; expiresAt: number }>();

function getSessionTtlSeconds(): number {
  const configured = Number(process.env.SESSION_TTL_SECONDS || process.env.JWT_EXPIRY_SECONDS || 0);
  if (Number.isFinite(configured) && configured > 0) return configured;
  return 60 * 60 * 24;
}

function getSessionKey(userId: number, sid: string): string {
  return `${SESSION_PREFIX}${userId}:${sid}`;
}

function getSessionRevocationKey(userId: number, sid: string): string {
  return `${SESSION_REVOCATION_PREFIX}${userId}:${sid}`;
}

function getSessionSecret(): Buffer {
  return Buffer.from(crypto.createHash("sha256").update(getJwtSecret()).digest());
}

export function encryptSessionPayload(payload: Record<string, unknown>): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", getSessionSecret(), iv);
  const payloadString = JSON.stringify(payload);
  const encrypted = Buffer.concat([
    cipher.update(payloadString, "utf8"),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  return Buffer.from(Buffer.concat([iv, tag, encrypted])).toString("base64url");
}

export function decryptSessionPayload(ciphertext: string): SessionRedisRecord {
  const buffer = Buffer.from(ciphertext, "base64url");
  const iv = buffer.subarray(0, 12);
  const tag = buffer.subarray(12, 28);
  const encrypted = buffer.subarray(28);
  const decipher = crypto.createDecipheriv("aes-256-gcm", getSessionSecret(), iv);
  decipher.setAuthTag(tag);
  const decrypted = Buffer.concat([
    decipher.update(encrypted),
    decipher.final(),
  ]).toString("utf8");

  return JSON.parse(decrypted) as SessionRedisRecord;
}

async function readSessionValue(key: string): Promise<string | null> {
  const redis = getRedisClient();
  if (redis) {
    return await redis.get(key);
  }

  const record = SESSION_FALLBACK_STORE.get(key);
  if (!record) return null;
  if (Date.now() > record.expiresAt) {
    SESSION_FALLBACK_STORE.delete(key);
    return null;
  }

  return record.value;
}

async function writeSessionValue(key: string, value: string, ttlSeconds: number): Promise<void> {
  const redis = getRedisClient();
  if (redis) {
    await redis.set(key, value, { EX: ttlSeconds });
    return;
  }

  SESSION_FALLBACK_STORE.set(key, {
    value,
    expiresAt: Date.now() + ttlSeconds * 1000,
  });
}

async function deleteSessionValue(key: string): Promise<void> {
  const redis = getRedisClient();
  if (redis) {
    await redis.del(key);
    return;
  }

  SESSION_FALLBACK_STORE.delete(key);
}

async function writeRevocationMarker(userId: number, sid: string, ttlSeconds: number): Promise<void> {
  const redis = getRedisClient();
  const key = getSessionRevocationKey(userId, sid);

  if (redis) {
    await redis.set(key, "revoked", { EX: ttlSeconds });
    return;
  }

  SESSION_FALLBACK_STORE.set(key, {
    value: "revoked",
    expiresAt: Date.now() + ttlSeconds * 1000,
  });
}

async function isRevoked(userId: number, sid: string): Promise<boolean> {
  const redis = getRedisClient();
  const key = getSessionRevocationKey(userId, sid);

  if (redis) {
    const status = await redis.get(key);
    return status === "revoked";
  }

  const record = SESSION_FALLBACK_STORE.get(key);
  if (!record) return false;
  if (Date.now() > record.expiresAt) {
    SESSION_FALLBACK_STORE.delete(key);
    return false;
  }

  return record.value === "revoked";
}

export async function storeEncryptedSession(
  payload: SessionRedisRecord,
  ttlSeconds: number = getSessionTtlSeconds(),
): Promise<{ key: string; ttlSeconds: number; sid: string }> {
  const sid = payload.sid ?? payload.sessionId ?? crypto.randomUUID();
  const sessionRecord: SessionRedisRecord = {
    ...payload,
    sid,
    createdAt: payload.createdAt ?? new Date().toISOString(),
    expiresAt: payload.expiresAt ?? new Date(Date.now() + ttlSeconds * 1000).toISOString(),
    exp: payload.exp ?? Math.floor((Date.now() + ttlSeconds * 1000) / 1000),
  };

  const key = getSessionKey(sessionRecord.userId, sid);
  await writeSessionValue(key, encryptSessionPayload(sessionRecord as unknown as Record<string, unknown>), ttlSeconds);

  return { key, ttlSeconds, sid };
}

export async function validateSessionToken(payload: Partial<JwtPayload> | string): Promise<boolean> {
  const sessionPayload = typeof payload === "string" ? verifyToken(payload) : payload;
  if (!sessionPayload || !sessionPayload.userId) return false;

  const sid = sessionPayload.sid ?? sessionPayload.sessionId;
  if (!sid) return false;

  if (await isRevoked(sessionPayload.userId, sid)) return false;

  const key = getSessionKey(sessionPayload.userId, sid);
  const encryptedPayload = await readSessionValue(key);
  if (!encryptedPayload) return false;

  try {
    const decoded = decryptSessionPayload(encryptedPayload) as SessionRedisRecord;
    if (decoded.userId !== sessionPayload.userId || decoded.sid !== sid) return false;
    const expiresAt = decoded.exp ?? Math.floor(new Date(decoded.expiresAt ?? Date.now()).getTime() / 1000);
    if (expiresAt && Date.now() / 1000 > expiresAt) {
      await deleteSessionValue(key);
      return false;
    }

    const activeTtl = Math.max(1, getSessionTtlSeconds());
    await writeSessionValue(key, encryptedPayload, activeTtl);
    return true;
  } catch {
    return false;
  }
}

export async function revokeSessionByToken(payloadOrToken: Partial<JwtPayload> | string): Promise<boolean> {
  const tokenPayload = typeof payloadOrToken === "string" ? verifyToken(payloadOrToken) : payloadOrToken;
  if (!tokenPayload || !tokenPayload.userId) return false;

  const sid = tokenPayload.sid ?? tokenPayload.sessionId;
  if (!sid) return false;

  const ttlSeconds = Math.max(60, Math.ceil((Number(tokenPayload.exp ?? 0) - Math.floor(Date.now() / 1000)) || 60));
  await writeRevocationMarker(tokenPayload.userId, sid, ttlSeconds);
  await deleteSessionValue(getSessionKey(tokenPayload.userId, sid));
  return true;
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
  const sessionId = payload.sid ?? payload.sessionId ?? crypto.randomUUID();

  return jwt.sign({ ...payload, sid: sessionId }, secret, {
    expiresIn: (expiresIn || `${expiryHours}h`) as NonNullable<SignOptions["expiresIn"]>,
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
  const payload = verifyToken(token);
  const expiryHours = getJwtExpiryHours();
  const expiresAt = new Date();
  expiresAt.setHours(expiresAt.getHours() + expiryHours);

  const sessionPayload: SessionRedisRecord = {
    userId: relayerId,
    email: payload?.email ?? "unknown@example.com",
    role: payload?.role ?? "VIEWER",
    sid: payload?.sid ?? payload?.sessionId ?? crypto.randomUUID(),
    ipAddress,
    userAgent,
    createdAt: new Date().toISOString(),
    expiresAt: expiresAt.toISOString(),
    exp: Math.floor(expiresAt.getTime() / 1000),
  };

  await storeEncryptedSession(sessionPayload, getSessionTtlSeconds());

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
  const payload = verifyToken(token);
  if (payload) {
    await revokeSessionByToken(payload);
  }

  await prisma.userSession.updateMany({
    where: { token, isActive: true },
    data: { isActive: false },
  });
}

export async function getActiveSession(
  token: string,
): Promise<{ relayerId: number; expiresAt: Date } | null> {
  const payload = verifyToken(token);
  if (!payload) return null;

  const isValid = await validateSessionToken(payload);
  if (!isValid) return null;

  const expiresAt = payload.exp ? new Date(payload.exp * 1000) : new Date(Date.now() + getSessionTtlSeconds() * 1000);
  return { relayerId: payload.userId, expiresAt };
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