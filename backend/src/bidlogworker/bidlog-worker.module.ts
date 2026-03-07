import { Module } from '@nestjs/common';
import { QueueModule } from '../queue/queue.module';
import { SaveBidlogWorker } from './save-bidlog.worker';
import { RedisModule } from '../redis/redis.module';
import { BidLogModule } from '../bid-log/bid-log.module';

@Module({
  imports: [QueueModule, RedisModule, BidLogModule], // RedisModule은 pub/sub 위함
  providers: [SaveBidlogWorker],
})
export class BidlogWorkerModule {}
