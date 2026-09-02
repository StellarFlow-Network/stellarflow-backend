import { Injectable, Logger, OnModuleDestroy } from "@nestjs/common";
import { createClient, RedisClientType } from "redis";
import { MessageBus } from "./message-bus.interface";
import { pack } from "../serialization/binaryPack";

@Injectable()
export class RedisPubSubService implements MessageBus, OnModuleDestroy {
  private readonly logger = new Logger(RedisPubSubService.name);
  private publisher: RedisClientType;

  constructor() {
    const isCiOrTest =
      process.env.NODE_ENV === "test" ||
      process.env.CI?.toLowerCase() === "true" ||
      process.env.GITHUB_ACTIONS?.toLowerCase() === "true";
    if (isCiOrTest) {
      this.publisher = createClient({ url: "redis://127.0.0.1:6379" });
      return;
    }

    this.publisher = createClient({
      url: process.env.REDIS_URL || "redis://localhost:6379",
    });

    this.publisher.connect().catch((err) => {
      this.logger.error("Redis Publisher Connection Failed", err);
    });
  }

  async publish<T = any>(channel: string, message: T): Promise<void> {
    const payload = Buffer.from(pack(message));
    await this.publisher.publish(channel, payload);

    this.logger.debug(`Published to ${channel}`);
  }

  async subscribe(): Promise<void> {
    throw new Error("Use RedisSubscriberService for subscriptions");
  }

  async onModuleDestroy() {
    await this.publisher.quit();
  }
}
