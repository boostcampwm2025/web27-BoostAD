import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Job } from 'bullmq';
import { BidLogRepository } from '../bid-log/repositories/bid-log.repository.interface';
import { BidLogJobData, BidLogJobItemData } from '../queue/types/queue.type';
import { BidLog } from '../bid-log/bid-log.types';
import { type AppIORedisClient } from '../redis/redis.type';

export interface SaveBidLogProps {
  auctionId: string;
  blogId: number;
  isHighIntent: boolean;
  behaviorScore: number;
  items: BidLogJobItemData[];
}

@Processor('bidlog-queue')
export class SaveBidlogWorker extends WorkerHost {
  constructor(
    private readonly bidLogRepository: BidLogRepository,
    private readonly ioRedisClient: AppIORedisClient
  ) {
    super();
  }

  async process(job: Job) {
    if (job.name === 'save-bidlog') {
      const { auctionId, blogId, isHighIntent, behaviorScore, items } =
        job.data as BidLogJobData;

      const saveBids = await this.saveBidLog({
        auctionId,
        blogId,
        isHighIntent,
        behaviorScore,
        items,
      });

      await this.ioRedisClient.publish(
        'complete-save-bidlog',
        JSON.stringify(saveBids)
      );
    }
  }

  private async saveBidLog({
    auctionId,
    blogId,
    isHighIntent,
    behaviorScore,
    items,
  }: SaveBidLogProps): Promise<BidLog[]> {
    const bidLogs: BidLog[] = [];
    for (const item of items) {
      bidLogs.push({
        auctionId,
        blogId,
        behaviorScore,
        bidPrice: item.bidPrice,
        campaignId: item.campaignId,
        isHighIntent,
        reason: item.reason,
        status: item.status,
      });
    }
    return await this.bidLogRepository.saveMany(bidLogs);
  }
}
