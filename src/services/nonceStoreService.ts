import { createHash } from "crypto";
import { getRedisClient } from "../lib/redis";
import { createFetcherLogger } from "../utils/logger";

const NONCE_TTL_SECONDS = 300;

export class CryptographicNonceStore {
  private readonly logger = createFetcherLogger("CryptographicNonceStore");
  private readonly inMemoryStore = new Set<string>();

  constructor(private readonly ttlSeconds: number = NONCE_TTL_SECONDS) {}

  private normalizeClientId(clientId: string): string {
    const value = (clientId ?? "").trim();
    if (!value) {
      throw new Error("Client ID is required to validate a nonce");
    }
    return value;
  }

  private normalizeNonce(nonce: string): string {
    const value = (nonce ?? "").trim();
    if (!value) {
      throw new Error("Nonce value is required");
    }
    return value;
  }

  private hashNonce(clientId: string, nonce: string): string {
    return createHash("sha256")
      .update(`${this.normalizeClientId(clientId)}:${this.normalizeNonce(nonce)}`)
      .digest("hex");
  }

  private getRedisKey(clientId: string, nonce: string): string {
    return `anti-replay:${this.normalizeClientId(clientId)}:${this.hashNonce(clientId, nonce)}`;
  }

  /**
   * Atomically reserves a nonce for a client using Redis SET NX with TTL.
   * Uses in-memory Set fallback when Redis is unavailable.
   * Returns true only if the nonce has not been seen before within the TTL window.
   */
  async consume(clientId: string, nonce: string): Promise<boolean> {
    const key = this.getRedisKey(clientId, nonce);
    const redis = getRedisClient();

    if (!redis) {
      if (this.inMemoryStore.has(key)) {
        this.logger.warn("Rejected replayed request nonce (in-memory)", {
          clientId: this.normalizeClientId(clientId),
          nonceHash: this.hashNonce(clientId, nonce),
        });
        return false;
      }
      this.inMemoryStore.add(key);
      setTimeout(() => this.inMemoryStore.delete(key), this.ttlSeconds * 1000);
      return true;
    }

    const result = await redis.set(key, "1", {
      NX: true,
      EX: this.ttlSeconds,
    });

    if (result === "OK") {
      return true;
    }

    this.logger.warn("Rejected replayed request nonce", {
      clientId: this.normalizeClientId(clientId),
      nonceHash: this.hashNonce(clientId, nonce),
      ttlSeconds: this.ttlSeconds,
    });

    return false;
  }

  /**
   * Convenience alias for callers that want the same anti-replay check with a more descriptive name.
   */
  async verifyAndStore(clientId: string, nonce: string): Promise<boolean> {
    return this.consume(clientId, nonce);
  }

  /**
   * Explicitly check whether a nonce is already present without consuming it.
   */
  async hasSeenNonce(clientId: string, nonce: string): Promise<boolean> {
    const key = this.getRedisKey(clientId, nonce);
    const redis = getRedisClient();
    if (!redis) {
      return this.inMemoryStore.has(key);
    }

    return (await redis.exists(key)) === 1;
  }

  /**
   * Remove a nonce from the current anti-replay set when an operation must be retried or explicitly cancelled.
   */
  async invalidate(clientId: string, nonce: string): Promise<void> {
    const key = this.getRedisKey(clientId, nonce);
    this.inMemoryStore.delete(key);

    const redis = getRedisClient();
    if (!redis) {
      return;
    }

    await redis.del(key);
  }
}

export const cryptographicNonceStore = new CryptographicNonceStore();
export default cryptographicNonceStore;
