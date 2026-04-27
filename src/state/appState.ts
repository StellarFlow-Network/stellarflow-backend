import { getRedisClient } from "../lib/redis";

const LOCKDOWN_REDIS_KEY = "stellarflow:lockdown:v1";
const LOCKDOWN_MESSAGE =
  "Backend lockdown is enabled. Transaction signing is disabled.";

export interface LockdownState {
  isLocked: boolean;
  reason: string | null;
  updatedAt: string | null;
}

const defaultLockdownState: LockdownState = {
  isLocked: false,
  reason: null,
  updatedAt: null,
};

let inMemoryLockdownState: LockdownState = { ...defaultLockdownState };

function normalizeReason(reason: unknown): string | null {
  if (typeof reason !== "string") {
    return null;
  }

  const trimmedReason = reason.trim();
  return trimmedReason.length > 0 ? trimmedReason : null;
}

function normalizeLockdownState(value: unknown): LockdownState {
  if (!value || typeof value !== "object") {
    return { ...defaultLockdownState };
  }

  const state = value as Partial<LockdownState>;

  return {
    isLocked: state.isLocked === true,
    reason: normalizeReason(state.reason),
    updatedAt:
      typeof state.updatedAt === "string" && state.updatedAt.length > 0
        ? state.updatedAt
        : null,
  };
}

async function persistLockdownState(state: LockdownState): Promise<void> {
  inMemoryLockdownState = state;

  const redisClient = getRedisClient();
  if (!redisClient || !redisClient.isReady) {
    return;
  }

  await redisClient.set(LOCKDOWN_REDIS_KEY, JSON.stringify(state));
}

export async function getLockdownState(): Promise<LockdownState> {
  const redisClient = getRedisClient();
  if (!redisClient || !redisClient.isReady) {
    return inMemoryLockdownState;
  }

  try {
    const cachedState = await redisClient.get(LOCKDOWN_REDIS_KEY);
    if (!cachedState) {
      return inMemoryLockdownState;
    }

    const parsedState = normalizeLockdownState(JSON.parse(cachedState));
    inMemoryLockdownState = parsedState;
    return parsedState;
  } catch (error) {
    console.warn(
      "[AppState] Failed to read lockdown state from Redis. Falling back to in-memory state:",
      error,
    );
    return inMemoryLockdownState;
  }
}

export async function isLockdownEnabled(): Promise<boolean> {
  const lockdownState = await getLockdownState();
  return lockdownState.isLocked;
}

export async function setLockdownState(
  isLocked: boolean,
  options?: { reason?: string | null },
): Promise<LockdownState> {
  const nextState: LockdownState = {
    isLocked,
    reason: isLocked ? normalizeReason(options?.reason) : null,
    updatedAt: new Date().toISOString(),
  };

  await persistLockdownState(nextState);
  return nextState;
}

export async function toggleLockdownState(options?: {
  reason?: string | null;
}): Promise<LockdownState> {
  const currentState = await getLockdownState();

  return setLockdownState(!currentState.isLocked, {
    reason: options?.reason ?? currentState.reason,
  });
}

export class LockdownError extends Error {
  readonly statusCode = 423;

  constructor(reason?: string | null) {
    super(reason ? `${LOCKDOWN_MESSAGE} Reason: ${reason}` : LOCKDOWN_MESSAGE);
    this.name = "LockdownError";
  }
}

export function isLockdownError(error: unknown): error is LockdownError {
  return error instanceof LockdownError;
}

export async function assertSigningAllowed(): Promise<void> {
  const lockdownState = await getLockdownState();

  if (lockdownState.isLocked) {
    throw new LockdownError(lockdownState.reason);
  }
}
