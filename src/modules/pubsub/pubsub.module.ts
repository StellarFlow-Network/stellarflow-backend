import { Module } from '@nestjs/common';
import { RedisPubSubService } from './redis-pubsub.service';
import { RedisSubscriberService } from './redis-subscriber.service';
import { CacheModule } from '../cache/cache.module';

@Module({
  imports: [CacheModule],
  providers: [RedisPubSubService, RedisSubscriberService],
  exports: [RedisPubSubService],
})
export class PubSubModule {}