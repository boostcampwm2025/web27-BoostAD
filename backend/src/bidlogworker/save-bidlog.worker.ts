import { Inject, Logger } from '@nestjs/common';
import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Job } from 'bullmq';
import { BidLogRepository } from '../bid-log/repositories/bid-log.repository.interface';
import { BidLogJobData, BidLogJobItemData } from '../queue/types/queue.type';
import {
  BidCreatedEventPayload,
  BidCreatedPubSubMessage,
  BidLog,
} from '../bid-log/bid-log.types';
import { type AppIORedisClient } from '../redis/redis.type';
import { IOREDIS_CLIENT } from '../redis/redis.constant';
import { BID_LOG_CREATED_CHANNEL } from '../bid-log/bid-log.constants';
import { MetricsService } from '../metrics/metrics.service';

export interface SaveBidLogProps {
  auctionId: string;
  blogId: number;
  isHighIntent: boolean;
  behaviorScore: number | null;
  postUrl: string;
  items: BidLogJobItemData[];
}

@Processor('bidlog-queue')
export class SaveBidlogWorker extends WorkerHost {
  private readonly logger = new Logger(SaveBidlogWorker.name);

  constructor(
    private readonly bidLogRepository: BidLogRepository,
    private readonly metricsService: MetricsService,
    @Inject(IOREDIS_CLIENT)
    private readonly ioRedisClient: AppIORedisClient
  ) {
    super();
  }

  async process(job: Job<BidLogJobData>) {
    if (job.name === 'save-bidlog') {
      const { auctionId, blogId, isHighIntent, behaviorScore, items } =
        job.data;

      const saveBids = await this.measureStage('save_bidlog', () =>
        this.measureDependency('mysql', 'save_bid_logs', () =>
          this.saveBidLog({
            auctionId,
            blogId,
            isHighIntent,
            behaviorScore,
            postUrl: job.data.postUrl,
            items,
          })
        )
      );

      const message = this.buildPubSubMessage(saveBids, job.data);

      await this.ioRedisClient.publish(
        BID_LOG_CREATED_CHANNEL,
        JSON.stringify(message)
      );
    }
  }

  private async saveBidLog({
    auctionId,
    blogId,
    isHighIntent,
    behaviorScore,
    postUrl,
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
        postUrl,
        reason: item.reason,
        status: item.status,
      });
    }
    return await this.bidLogRepository.saveMany(bidLogs);
  }

  private buildPubSubMessage(
    savedBids: BidLog[],
    jobData: BidLogJobData
  ): BidCreatedPubSubMessage {
    if (savedBids.length !== jobData.items.length) {
      this.logger.warn(
        `저장된 BidLog 수(${savedBids.length})와 job item 수(${jobData.items.length})가 일치하지 않습니다`
      );
    }

    const events: BidCreatedEventPayload[] = savedBids.flatMap((log, index) => {
      const item = jobData.items[index];

      if (!item) {
        this.logger.warn(
          `job item 누락으로 SSE 이벤트를 건너뜁니다. auctionId=${jobData.auctionId}, index=${index}`
        );
        return [];
      }

      return [
        {
          log,
          userId: item.userId,
          campaignTitle: item.campaignTitle,
          blogKey: jobData.blogKey,
          blogName: jobData.blogName,
          winAmount: jobData.winAmount,
        },
      ];
    });

    return {
      publishedAt: new Date().toISOString(),
      events,
    };
  }

  private async measureStage<T>(
    stage: string,
    work: () => Promise<T>
  ): Promise<T> {
    const startedAt = process.hrtime.bigint();

    try {
      const result = await work();
      this.metricsService.recordRtbStage(
        stage,
        'ok',
        this.elapsedMs(startedAt)
      );
      return result;
    } catch (error) {
      this.metricsService.recordRtbStage(
        stage,
        'error',
        this.elapsedMs(startedAt)
      );
      throw error;
    }
  }

  private async measureDependency<T>(
    dependency: string,
    operation: string,
    work: () => Promise<T>
  ): Promise<T> {
    const startedAt = process.hrtime.bigint();

    try {
      const result = await work();
      this.metricsService.recordDependency(
        dependency,
        operation,
        'ok',
        this.elapsedMs(startedAt)
      );
      return result;
    } catch (error) {
      this.metricsService.recordDependency(
        dependency,
        operation,
        'error',
        this.elapsedMs(startedAt)
      );
      throw error;
    }
  }

  private elapsedMs(startedAt: bigint): number {
    return Number(process.hrtime.bigint() - startedAt) / 1_000_000;
  }
}
