import { createClient, type RedisClientType } from "redis";
import dotenv from "dotenv";

dotenv.config();

const redisUrl = process.env.REDIS_URL;

let redisClient: RedisClientType | null = null;

if (redisUrl) {
  redisClient = createClient({
    url: redisUrl,
    socket: {
      connectTimeout: 3000,
      reconnectStrategy: (retries) => Math.min(retries * 50, 1000),
    },
  });

  redisClient.on("error", (error) => {
    console.error("[Redis] Client error:", error);
  });

  redisClient.on("connect", () => {
    console.info("[Redis] Connected");
  });

  redisClient.on("reconnecting", () => {
    console.warn("[Redis] Reconnecting...");
  });

  void redisClient.connect().catch((error) => {
    console.error(
      "[Redis] Failed to connect. Continuing without Redis cache:",
      error,
    );
  });
} else {
  console.info("[Redis] REDIS_URL not set. Redis caching is disabled.");
}

export function getRedisClient(): RedisClientType | null {
  return redisClient;
}

export async function disconnectRedis(): Promise<void> {
  if (!redisClient || !redisClient.isOpen) {
    return;
  }

  await redisClient.quit();
}
