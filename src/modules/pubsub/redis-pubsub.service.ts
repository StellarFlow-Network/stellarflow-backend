import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { createClient, RedisClientType } from 'redis';
import { MessageBus } from './message-bus.interface';

@Injectable()
export class RedisPubSubService implements MessageBus, OnModuleDestroy {
  private readonly logger = new Logger(RedisPubSubService.name);
  private publisher: RedisClientType;

  constructor() {
    this.publisher = createClient({
      url: process.env.REDIS_URL || 'redis://localhost:6379',
    });

    this.publisher.connect().catch((err) => {
      this.logger.error('Redis Publisher Connection Failed', err);
    });
  }

  async publish<T = any>(channel: string, message: T): Promise<void> {
    const payload = JSON.stringify(message);
    await this.publisher.publish(channel, payload);

    this.logger.debug(`Published to ${channel}`);
  }

  async subscribe(): Promise<void> {
    throw new Error('Use RedisSubscriberService for subscriptions');
  }

  async onModuleDestroy() {
    await this.publisher.quit();
  }
}