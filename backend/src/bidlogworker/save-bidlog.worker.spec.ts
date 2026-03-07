import { SaveBidlogWorker } from './save-bidlog.worker';
import { BidLogRepository } from '../bid-log/repositories/bid-log.repository.interface';
import { BID_LOG_CREATED_CHANNEL } from '../bid-log/bid-log.constants';
import { BidStatus } from '../bid-log/bid-log.types';
import type { BidLogJobData } from '../queue/types/queue.type';
import { MetricsService } from '../metrics/metrics.service';

describe('SaveBidlogWorker', () => {
  let worker: SaveBidlogWorker;
  let bidLogRepository: { saveMany: jest.Mock };
  let ioRedisClient: { publish: jest.Mock };
  let metricsService: {
    recordRtbStage: jest.Mock;
    recordDependency: jest.Mock;
  };

  beforeEach(() => {
    bidLogRepository = {
      saveMany: jest.fn(),
    };
    ioRedisClient = {
      publish: jest.fn().mockResolvedValue(1),
    };
    metricsService = {
      recordRtbStage: jest.fn(),
      recordDependency: jest.fn(),
    };

    worker = new SaveBidlogWorker(
      bidLogRepository as unknown as BidLogRepository,
      metricsService as unknown as MetricsService,
      ioRedisClient as never
    );
  });

  it('saves bid logs with postUrl and publishes enriched bid-created events', async () => {
    const createdAt = new Date('2026-03-07T09:00:00.000Z');
    const jobData: BidLogJobData = {
      auctionId: 'auction-1',
      blogId: 7,
      blogKey: 'blog-key',
      blogName: 'Boost Blog',
      isHighIntent: true,
      behaviorScore: 92,
      postUrl: 'https://blog.example.com/posts/1',
      winAmount: 1800,
      items: [
        {
          campaignId: 'campaign-a',
          status: BidStatus.WIN,
          bidPrice: 1800,
          reason: '',
          userId: 11,
          campaignTitle: 'Campaign A',
        },
        {
          campaignId: 'campaign-b',
          status: BidStatus.LOSS,
          bidPrice: 1500,
          reason: '',
          userId: 12,
          campaignTitle: 'Campaign B',
        },
      ],
    };

    bidLogRepository.saveMany.mockResolvedValue([
      {
        id: 1,
        createdAt,
        auctionId: 'auction-1',
        blogId: 7,
        campaignId: 'campaign-a',
        status: BidStatus.WIN,
        bidPrice: 1800,
        isHighIntent: true,
        behaviorScore: 92,
        postUrl: 'https://blog.example.com/posts/1',
        reason: '',
      },
      {
        id: 2,
        createdAt,
        auctionId: 'auction-1',
        blogId: 7,
        campaignId: 'campaign-b',
        status: BidStatus.LOSS,
        bidPrice: 1500,
        isHighIntent: true,
        behaviorScore: 92,
        postUrl: 'https://blog.example.com/posts/1',
        reason: '',
      },
    ]);

    await worker.process({
      name: 'save-bidlog',
      data: jobData,
    } as never);

    expect(bidLogRepository.saveMany).toHaveBeenCalledWith([
      {
        auctionId: 'auction-1',
        blogId: 7,
        behaviorScore: 92,
        bidPrice: 1800,
        campaignId: 'campaign-a',
        isHighIntent: true,
        postUrl: 'https://blog.example.com/posts/1',
        reason: '',
        status: BidStatus.WIN,
      },
      {
        auctionId: 'auction-1',
        blogId: 7,
        behaviorScore: 92,
        bidPrice: 1500,
        campaignId: 'campaign-b',
        isHighIntent: true,
        postUrl: 'https://blog.example.com/posts/1',
        reason: '',
        status: BidStatus.LOSS,
      },
    ]);

    expect(ioRedisClient.publish).toHaveBeenCalledTimes(1);
    expect(ioRedisClient.publish.mock.calls[0][0]).toBe(BID_LOG_CREATED_CHANNEL);
    expect(metricsService.recordDependency).toHaveBeenCalledWith(
      'mysql',
      'save_bid_logs',
      'ok',
      expect.any(Number)
    );
    expect(metricsService.recordRtbStage).toHaveBeenCalledWith(
      'save_bidlog',
      'ok',
      expect.any(Number)
    );

    const message = JSON.parse(ioRedisClient.publish.mock.calls[0][1]) as {
      publishedAt?: string;
      events: Array<{
        userId: number;
        campaignTitle: string;
        blogKey: string;
        blogName: string;
        winAmount: number | null;
        log: {
          campaignId: string;
          postUrl: string | null;
        };
      }>;
    };

    expect(message).toEqual({
      publishedAt: expect.any(String),
      events: [
        {
          userId: 11,
          campaignTitle: 'Campaign A',
          blogKey: 'blog-key',
          blogName: 'Boost Blog',
          winAmount: 1800,
          log: expect.objectContaining({
            campaignId: 'campaign-a',
            postUrl: 'https://blog.example.com/posts/1',
          }),
        },
        {
          userId: 12,
          campaignTitle: 'Campaign B',
          blogKey: 'blog-key',
          blogName: 'Boost Blog',
          winAmount: 1800,
          log: expect.objectContaining({
            campaignId: 'campaign-b',
            postUrl: 'https://blog.example.com/posts/1',
          }),
        },
      ],
    });
  });
});
