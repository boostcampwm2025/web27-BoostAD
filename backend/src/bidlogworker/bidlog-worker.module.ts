import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { QueueModule } from '../queue/queue.module';
import { SaveBidlogWorker } from './save-bidlog.worker';
import { RedisModule } from '../redis/redis.module';
import { BidLogRepository } from '../bid-log/repositories/bid-log.repository.interface';
import { TypeOrmBidLogRepository } from '../bid-log/repositories/typeorm-bid-log.repository';
import { BidLogEntity } from '../bid-log/entities/bid-log.entity';
import { getTypeOrmConfig } from '../config/typeorm.config';
import { MetricsModule } from '../metrics/metrics.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    TypeOrmModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (configService: ConfigService) =>
        getTypeOrmConfig(configService),
    }),
    QueueModule,
    RedisModule,
    MetricsModule,
    TypeOrmModule.forFeature([BidLogEntity]),
  ],
  providers: [
    SaveBidlogWorker,
    {
      provide: BidLogRepository,
      useClass: TypeOrmBidLogRepository,
    },
  ],
})
export class BidlogWorkerModule {}
