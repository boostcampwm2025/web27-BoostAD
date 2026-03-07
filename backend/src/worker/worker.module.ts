import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { TypeOrmModule } from '@nestjs/typeorm';
import { CampaignCacheRepository } from 'src/campaign/repository/campaign.cache.repository.interface';
import { RedisCampaignCacheRepository } from 'src/campaign/repository/redis-campaign.cache.repository';
import { QueueModule } from 'src/queue/queue.module';
import { EmbeddingWorker } from 'src/worker/embedding.worker';
import { RedisModule } from 'src/redis/redis.module';
import { MLEngine } from 'src/rtb/ml/mlEngine.interface';
import { XenovaMLEngine } from 'src/rtb/ml/xenova-mlEngine';
import { CacheRepository } from 'src/cache/repository/cache.repository.interface';
import { RedisCacheRepository } from 'src/cache/repository/redis-cache.repository';
import { RedisTTLWorker } from './redis-ttl.worker';
import { getTypeOrmConfig } from 'src/config/typeorm.config';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    EventEmitterModule.forRoot(),
    TypeOrmModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (configService: ConfigService) =>
        getTypeOrmConfig(configService),
    }),
    RedisModule,
    QueueModule,
  ],
  providers: [
    EmbeddingWorker,
    RedisTTLWorker,
    { provide: MLEngine, useClass: XenovaMLEngine },
    {
      provide: CampaignCacheRepository,
      useClass: RedisCampaignCacheRepository,
    },
    {
      provide: CacheRepository,
      useClass: RedisCacheRepository,
    },
  ],
})
export class WorkerModule {}
