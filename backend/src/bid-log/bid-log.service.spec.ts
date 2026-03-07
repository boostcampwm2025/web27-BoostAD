import { EventEmitter2 } from '@nestjs/event-emitter';
import { BidLogService } from './bid-log.service';
import { BidLogRepository } from './repositories/bid-log.repository.interface';
import { CampaignRepository } from 'src/campaign/repository/campaign.repository.interface';
import { BlogRepository } from 'src/blog/repository/blog.repository.interface';
import { MetricsService } from 'src/metrics/metrics.service';
import { BID_LOG_CREATED_CHANNEL } from './bid-log.constants';
import { BidStatus } from './bid-log.types';

describe('BidLogService', () => {
  let service: BidLogService;
  let subscriber: {
    subscribe: jest.Mock;
    on: jest.Mock;
    unsubscribe: jest.Mock;
    disconnect: jest.Mock;
  };
  let metricsService: {
    incSseConnections: jest.Mock;
    decSseConnections: jest.Mock;
  };
  let redisClient: {
    duplicate: jest.Mock;
  };
  let messageHandler:
    | ((channel: string, message: string) => void)
    | undefined;

  beforeEach(() => {
    messageHandler = undefined;
    subscriber = {
      subscribe: jest.fn().mockResolvedValue(undefined),
      on: jest.fn((event: string, handler: (channel: string, message: string) => void) => {
        if (event === 'message') {
          messageHandler = handler;
        }
      }),
      unsubscribe: jest.fn().mockResolvedValue(undefined),
      disconnect: jest.fn(),
    };
    metricsService = {
      incSseConnections: jest.fn(),
      decSseConnections: jest.fn(),
    };
    redisClient = {
      duplicate: jest.fn().mockReturnValue(subscriber),
    };

    service = new BidLogService(
      {} as BidLogRepository,
      {} as CampaignRepository,
      {} as BlogRepository,
      new EventEmitter2(),
      metricsService as unknown as MetricsService,
      redisClient as never
    );
  });

  it('subscribes to redis and forwards matching user events through SSE', async () => {
    await service.onModuleInit();

    const received: Array<{ data: string }> = [];
    const subscription = service
      .subscribeToBidEvents(11)
      .subscribe((event) => received.push(event as { data: string }));

    expect(metricsService.incSseConnections).toHaveBeenCalledWith('bidlog');
    expect(subscriber.subscribe).toHaveBeenCalledWith(BID_LOG_CREATED_CHANNEL);

    messageHandler?.(
      BID_LOG_CREATED_CHANNEL,
      JSON.stringify({
        events: [
          {
            userId: 11,
            campaignTitle: 'Campaign A',
            blogKey: 'blog-key',
            blogName: 'Boost Blog',
            winAmount: 1800,
            log: {
              id: 1,
              createdAt: '2026-03-07T09:00:00.000Z',
              auctionId: 'auction-1',
              campaignId: 'campaign-a',
              blogId: 7,
              status: BidStatus.WIN,
              bidPrice: 1800,
              reason: '',
              isHighIntent: true,
              behaviorScore: 92,
              postUrl: 'https://blog.example.com/posts/1',
            },
          },
          {
            userId: 12,
            campaignTitle: 'Campaign B',
            blogKey: 'blog-key',
            blogName: 'Boost Blog',
            winAmount: 1800,
            log: {
              id: 2,
              createdAt: '2026-03-07T09:00:00.000Z',
              auctionId: 'auction-1',
              campaignId: 'campaign-b',
              blogId: 7,
              status: BidStatus.LOSS,
              bidPrice: 1500,
              reason: '',
              isHighIntent: true,
              behaviorScore: 92,
              postUrl: 'https://blog.example.com/posts/1',
            },
          },
        ],
      })
    );

    expect(received).toEqual([
      {
        data: JSON.stringify({
          id: 1,
          createdAt: '2026-03-07T09:00:00.000Z',
          campaignId: 'campaign-a',
          campaignTitle: 'Campaign A',
          blogKey: 'blog-key',
          blogName: 'Boost Blog',
          postUrl: 'https://blog.example.com/posts/1',
          bidAmount: 1800,
          winAmount: 1800,
          isWon: true,
          isHighIntent: true,
          behaviorScore: 92,
        }),
      },
    ]);

    subscription.unsubscribe();

    expect(metricsService.decSseConnections).toHaveBeenCalledWith('bidlog');

    await service.onModuleDestroy();

    expect(subscriber.unsubscribe).toHaveBeenCalledWith(
      BID_LOG_CREATED_CHANNEL
    );
    expect(subscriber.disconnect).toHaveBeenCalled();
  });
});
