import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { QueueModule } from '../queue/queue.module';
import { SaveBidlogWorker } from './save-bidlog.worker';
import { RedisModule } from '../redis/redis.module';
import { BidLogRepository } from '../bid-log/repositories/bid-log.repository.interface';
import { TypeOrmBidLogRepository } from '../bid-log/repositories/typeorm-bid-log.repository';
import { BidLogEntity } from '../bid-log/entities/bid-log.entity';

@Module({
  imports: [
    QueueModule,
    RedisModule,
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
