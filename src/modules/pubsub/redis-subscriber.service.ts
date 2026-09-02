import {
  Injectable,
  Logger,
  OnModuleInit,
  OnModuleDestroy,
} from "@nestjs/common";
import { createClient, RedisClientType } from "redis";
import { CHANNELS } from "./constants/channels";
import { PriceCacheService } from "../cache/price-cache.service";
import { unpack } from "../serialization/binaryPack";

@Injectable()
export class RedisSubscriberService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(RedisSubscriberService.name);
  private subscriber: RedisClientType;

  constructor(private readonly priceCache: PriceCacheService) {
    this.subscriber = createClient({
      url: process.env.REDIS_URL || "redis://localhost:6379",
    });
  }

  async onModuleInit() {
    const isCiOrTest =
      process.env.NODE_ENV === "test" ||
      process.env.CI?.toLowerCase() === "true" ||
      process.env.GITHUB_ACTIONS?.toLowerCase() === "true";
    if (isCiOrTest) {
      return;
    }

    await this.subscriber.connect();

    await this.subscriber.subscribe(CHANNELS.PRICE_UPDATES, (message) => {
      try {
        const payload =
          typeof message === "string" ? Buffer.from(message, "utf-8") : message;
        const data = unpack(payload);
        this.handlePriceUpdate(data);
      } catch (err) {
        this.logger.error("Invalid message received", err);
      }
    });

    this.logger.log("Redis Subscriber listening...");
  }

  private handlePriceUpdate(data: any) {
    const { symbol, price } = data;

    this.priceCache.set(symbol, price);

    this.logger.debug(`Synced price: ${symbol} = ${price}`);
  }

  async onModuleDestroy() {
    await this.subscriber.quit();
  }
}
