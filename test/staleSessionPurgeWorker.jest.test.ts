process.env.JWT_SECRET =
  process.env.JWT_SECRET || "stellarflow-stale-session-purge-test-secret";

import {
  StaleSessionPurgeWorker,
  getStaleSessionPurgeWorker,
  resetStaleSessionPurgeWorker,
} from "../src/services/staleSessionPurgeWorker";
import {
  SESSION_KEY_PREFIX,
  encryptSessionPayload,
  generateToken,
  parseSessionKey,
} from "../src/utils/jwt";
import {
  claimSessionConnectionForToken,
  getActiveSessionConnectionCount,
  hasActiveSessionConnection,
  registerSessionConnection,
  resetSessionConnectionRegistry,
  unregisterSessionConnection,
} from "../src/lib/sessionConnectionRegistry";
import { logger } from "../src/utils/logger";
import jwt from "jsonwebtoken";

interface FakeSessionEntry {
  value: string;
  ttl: number;
}

const fakeStore = new Map<string, FakeSessionEntry>();
const scanBatchSizes: number[] = [];

const fakeRedis = {
  isOpen: true,
  ttl: jest.fn(async (key: string): Promise<number> => {
    return fakeStore.get(key)?.ttl ?? -2;
  }),
  get: jest.fn(async (key: string): Promise<string | null> => {
    return fakeStore.get(key)?.value ?? null;
  }),
  del: jest.fn(async (...args: unknown[]): Promise<number> => {
    const keys = args.flat() as string[];
    let deleted = 0;
    for (const key of keys) {
      if (fakeStore.delete(key)) deleted += 1;
    }
    return deleted;
  }),
  scanIterator: jest.fn(async function* (options: {
    MATCH: string;
    COUNT: number;
  }) {
    const matcher = new RegExp(`^${options.MATCH.replaceAll("*", ".*")}$`);
    const matching = [...fakeStore.keys()].filter((key) => matcher.test(key));
    const batchSize =
      options.COUNT > 0 ? options.COUNT : Math.max(matching.length, 1);

    for (let index = 0; index < matching.length; index += batchSize) {
      const batch = matching.slice(index, index + batchSize);
      scanBatchSizes.push(batch.length);
      yield batch;
    }
  }),
};

jest.mock("../src/lib/redis", () => ({
  getRedisClient: jest.fn(() => fakeRedis),
}));

jest.mock("../src/lib/prisma", () => ({
  prisma: {},
  default: {},
}));

jest.mock("../src/utils/logger", () => ({
  logger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
}));

const SESSION_USER_ID = 7;
const SESSION_TTL_SECONDS = 600;

function sessionKey(sid: string, userId: number = SESSION_USER_ID): string {
  return `${SESSION_KEY_PREFIX}${userId}:${sid}`;
}

function encryptSession(sid: string, expOffsetSeconds: number): string {
  const expiresAtMs = Date.now() + expOffsetSeconds * 1000;

  return encryptSessionPayload({
    userId: SESSION_USER_ID,
    email: "user@stellarflow.test",
    role: "VIEWER",
    sid,
    createdAt: new Date(Date.now() - 60_000).toISOString(),
    expiresAt: new Date(expiresAtMs).toISOString(),
    exp: Math.floor(expiresAtMs / 1000),
  });
}

function seedSession(
  sid: string,
  expOffsetSeconds: number,
  ttl: number = SESSION_TTL_SECONDS,
): string {
  const key = sessionKey(sid);
  fakeStore.set(key, { value: encryptSession(sid, expOffsetSeconds), ttl });
  return key;
}

describe("sessionConnectionRegistry", () => {
  beforeEach(() => {
    resetSessionConnectionRegistry();
  });

  afterEach(() => {
    resetSessionConnectionRegistry();
  });

  it("reports no active connections when none are registered", () => {
    expect(hasActiveSessionConnection("sid-1")).toBe(false);
    expect(getActiveSessionConnectionCount()).toBe(0);
  });

  it("tracks an active connection for a registered session", () => {
    registerSessionConnection("sid-1");

    expect(hasActiveSessionConnection("sid-1")).toBe(true);
    expect(hasActiveSessionConnection("sid-2")).toBe(false);
    expect(getActiveSessionConnectionCount()).toBe(1);
  });

  it("keeps a session active until every connection is released", () => {
    registerSessionConnection("sid-1");
    registerSessionConnection("sid-1");

    unregisterSessionConnection("sid-1");
    expect(hasActiveSessionConnection("sid-1")).toBe(true);

    unregisterSessionConnection("sid-1");
    expect(hasActiveSessionConnection("sid-1")).toBe(false);
    expect(getActiveSessionConnectionCount()).toBe(0);
  });

  it("ignores unregistration of unknown sessions", () => {
    expect(() => unregisterSessionConnection("unknown")).not.toThrow();
  });
});

describe("claimSessionConnectionForToken", () => {
  beforeEach(() => {
    resetSessionConnectionRegistry();
  });

  afterEach(() => {
    resetSessionConnectionRegistry();
  });

  it("claims the session carried by a valid handshake token", async () => {
    const token = generateToken({
      userId: SESSION_USER_ID,
      email: "user@stellarflow.test",
      role: "VIEWER",
      sid: "handshake-sid",
    });

    await expect(claimSessionConnectionForToken(token)).resolves.toBe(
      "handshake-sid",
    );
    expect(hasActiveSessionConnection("handshake-sid")).toBe(true);
    expect(getActiveSessionConnectionCount()).toBe(1);
  });

  it("ignores tokens that cannot be verified", async () => {
    await expect(
      claimSessionConnectionForToken("not-a-token"),
    ).resolves.toBeNull();
    expect(getActiveSessionConnectionCount()).toBe(0);
  });

  it("ignores tokens that do not carry a session id", async () => {
    const token = jwt.sign(
      { userId: SESSION_USER_ID },
      String(process.env.JWT_SECRET),
    );

    await expect(claimSessionConnectionForToken(token)).resolves.toBeNull();
    expect(getActiveSessionConnectionCount()).toBe(0);
  });
});

describe("parseSessionKey", () => {
  it("parses a user session key", () => {
    expect(parseSessionKey(sessionKey("abc-123"))).toEqual({
      userId: SESSION_USER_ID,
      sid: "abc-123",
    });
  });

  it("rejects keys outside the session namespace", () => {
    expect(parseSessionKey("stellarflow:session:revoked:7:abc")).toBeNull();
    expect(parseSessionKey("token_blacklist:some-jti")).toBeNull();
  });

  it("rejects malformed session keys", () => {
    expect(parseSessionKey(`${SESSION_KEY_PREFIX}no-separator`)).toBeNull();
    expect(parseSessionKey(`${SESSION_KEY_PREFIX}7:`)).toBeNull();
    expect(parseSessionKey(`${SESSION_KEY_PREFIX}not-a-number:sid`)).toBeNull();
  });
});

describe("StaleSessionPurgeWorker", () => {
  beforeEach(() => {
    fakeStore.clear();
    scanBatchSizes.length = 0;
    fakeRedis.isOpen = true;
    resetStaleSessionPurgeWorker();
    resetSessionConnectionRegistry();
    jest.clearAllMocks();
  });

  afterEach(() => {
    resetStaleSessionPurgeWorker();
    resetSessionConnectionRegistry();
    jest.useRealTimers();
  });

  describe("constructor", () => {
    it("creates an idle instance with hourly defaults", () => {
      const worker = new StaleSessionPurgeWorker();

      expect(worker.isActive()).toBe(false);
      expect(worker.isPurgeCycleRunning()).toBe(false);
      expect(worker.getMetrics()).toEqual({
        totalCycles: 0,
        totalKeysScanned: 0,
        totalSessionsPurged: 0,
        lastCycleAt: null,
        lastCycleDurationMs: 0,
        lastCycleScanned: 0,
        lastCyclePurged: 0,
      });
    });
  });

  describe("start/stop", () => {
    it("starts and stops the worker", () => {
      const worker = new StaleSessionPurgeWorker({
        purgeIntervalMs: 1000,
        runOnStart: false,
      });

      worker.start();
      expect(worker.isActive()).toBe(true);

      worker.stop();
      expect(worker.isActive()).toBe(false);
    });

    it("does not start twice", () => {
      const worker = new StaleSessionPurgeWorker({
        purgeIntervalMs: 1000,
        runOnStart: false,
      });

      worker.start();
      worker.start();

      expect(worker.isActive()).toBe(true);
      worker.stop();
      expect(logger.warn).toHaveBeenCalledWith(
        "[StaleSessionPurgeWorker] Already running",
      );
    });
  });

  describe("runPurgeCycle", () => {
    it("purges expired sessions that have no active WebSocket connection", async () => {
      seedSession("expired-sid", -60);

      const worker = new StaleSessionPurgeWorker({ runOnStart: false });
      const summary = await worker.runPurgeCycle();

      expect(summary).toEqual({
        scanned: 1,
        purged: 1,
        durationMs: expect.any(Number),
      });
      expect(fakeStore.size).toBe(0);
      expect(logger.info).toHaveBeenCalledWith(
        expect.stringContaining("purged=1"),
      );

      const metrics = worker.getMetrics();
      expect(metrics.totalCycles).toBe(1);
      expect(metrics.totalKeysScanned).toBe(1);
      expect(metrics.totalSessionsPurged).toBe(1);
      expect(metrics.lastCycleAt).toBeInstanceOf(Date);
      expect(metrics.lastCyclePurged).toBe(1);
    });

    it("retains sessions whose token has not expired", async () => {
      seedSession("live-sid", 3600);

      const worker = new StaleSessionPurgeWorker({ runOnStart: false });
      const summary = await worker.runPurgeCycle();

      expect(summary).toMatchObject({ scanned: 1, purged: 0 });
      expect(fakeStore.size).toBe(1);
      expect(logger.info).toHaveBeenCalledWith(
        expect.stringContaining("purged=0"),
      );
    });

    it("retains expired sessions that still own an active WebSocket connection", async () => {
      const key = seedSession("connected-sid", -60);
      registerSessionConnection("connected-sid");

      const worker = new StaleSessionPurgeWorker({ runOnStart: false });
      const summary = await worker.runPurgeCycle();

      expect(summary).toMatchObject({ scanned: 1, purged: 0 });
      expect(fakeStore.has(key)).toBe(true);

      unregisterSessionConnection("connected-sid");
      const secondSummary = await worker.runPurgeCycle();

      expect(secondSummary).toMatchObject({ scanned: 1, purged: 1 });
      expect(fakeStore.has(key)).toBe(false);
    });

    it("purges sessions whose Redis TTL has already elapsed", async () => {
      seedSession("ttl-elapsed-sid", 3600, 0);

      const worker = new StaleSessionPurgeWorker({ runOnStart: false });
      const summary = await worker.runPurgeCycle();

      expect(summary).toMatchObject({ scanned: 1, purged: 1 });
      expect(fakeStore.size).toBe(0);
    });

    it("judges sessions without a Redis expiry by their stored payload", async () => {
      const expiredKey = seedSession("no-ttl-expired", -60, -1);
      const liveKey = seedSession("no-ttl-live", 3600, -1);

      const worker = new StaleSessionPurgeWorker({ runOnStart: false });
      const summary = await worker.runPurgeCycle();

      expect(summary).toMatchObject({ scanned: 2, purged: 1 });
      expect(fakeStore.has(expiredKey)).toBe(false);
      expect(fakeStore.has(liveKey)).toBe(true);
    });

    it("retains session records it cannot decode", async () => {
      const key = sessionKey("undecryptable-sid");
      fakeStore.set(key, { value: "not-a-valid-ciphertext", ttl: 600 });

      const worker = new StaleSessionPurgeWorker({ runOnStart: false });
      const summary = await worker.runPurgeCycle();

      expect(summary).toMatchObject({ scanned: 1, purged: 0 });
      expect(fakeStore.has(key)).toBe(true);
    });

    it("ignores keys outside the user session namespace", async () => {
      fakeStore.set("stellarflow:session:revoked:7:abc", {
        value: "revoked",
        ttl: -1,
      });
      fakeStore.set("token_blacklist:some-jti", {
        value: "revoked",
        ttl: 60,
      });

      const worker = new StaleSessionPurgeWorker({ runOnStart: false });
      const summary = await worker.runPurgeCycle();

      expect(summary).toMatchObject({ scanned: 0, purged: 0 });
      expect(fakeStore.size).toBe(2);
    });

    it("scans the session namespace with the SCAN cursor in batches", async () => {
      for (let index = 0; index < 5; index += 1) {
        seedSession(`batch-sid-${index}`, -60);
      }

      const worker = new StaleSessionPurgeWorker({
        runOnStart: false,
        batchSize: 2,
      });
      const summary = await worker.runPurgeCycle();

      expect(fakeRedis.scanIterator).toHaveBeenCalledWith({
        MATCH: `${SESSION_KEY_PREFIX}*`,
        COUNT: 2,
      });
      expect(scanBatchSizes).toEqual([2, 2, 1]);
      expect(summary).toMatchObject({ scanned: 5, purged: 5 });
      expect(fakeStore.size).toBe(0);
    });

    it("skips the cycle when Redis is unavailable", async () => {
      seedSession("expired-sid", -60);
      fakeRedis.isOpen = false;

      const worker = new StaleSessionPurgeWorker({ runOnStart: false });
      const summary = await worker.runPurgeCycle();

      expect(summary).toBeNull();
      expect(fakeStore.size).toBe(1);
      expect(logger.warn).toHaveBeenCalledWith(
        expect.stringContaining("Redis not available"),
      );
    });

    it("returns null and logs when the cycle fails", async () => {
      seedSession("expired-sid", -60);
      fakeRedis.ttl.mockRejectedValueOnce(new Error("redis down"));

      const worker = new StaleSessionPurgeWorker({ runOnStart: false });
      const summary = await worker.runPurgeCycle();

      expect(summary).toBeNull();
      expect(worker.isPurgeCycleRunning()).toBe(false);
      expect(logger.error).toHaveBeenCalledWith(
        expect.stringContaining("Purge cycle failed"),
        expect.any(Error),
      );
    });
  });

  describe("hourly schedule", () => {
    it("runs a purge cycle on the hourly interval and logs the count", async () => {
      jest.useFakeTimers();
      seedSession("hourly-sid", -60);

      const worker = new StaleSessionPurgeWorker({ runOnStart: false });
      worker.start();
      expect(worker.isActive()).toBe(true);

      await jest.advanceTimersByTimeAsync(60 * 60 * 1000);

      expect(fakeStore.size).toBe(0);
      expect(logger.info).toHaveBeenCalledWith(
        expect.stringContaining("purged=1"),
      );

      worker.stop();
      expect(worker.isActive()).toBe(false);
    });

    it("runs an initial cycle on start when configured", async () => {
      jest.useFakeTimers();
      seedSession("startup-sid", -60);

      const worker = new StaleSessionPurgeWorker({ runOnStart: true });
      worker.start();

      await jest.advanceTimersByTimeAsync(0);

      expect(fakeStore.size).toBe(0);
      expect(logger.info).toHaveBeenCalledWith(
        expect.stringContaining("purged=1"),
      );

      worker.stop();
    });
  });

  describe("singleton", () => {
    it("returns the same instance from getStaleSessionPurgeWorker", () => {
      expect(getStaleSessionPurgeWorker()).toBe(getStaleSessionPurgeWorker());
    });

    it("resets the singleton with resetStaleSessionPurgeWorker", () => {
      const first = getStaleSessionPurgeWorker();
      resetStaleSessionPurgeWorker();
      const second = getStaleSessionPurgeWorker();

      expect(second).not.toBe(first);
    });
  });
});
