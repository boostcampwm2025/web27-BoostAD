import {
  Inject,
  Injectable,
  Logger,
  MessageEvent,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Observable } from 'rxjs';
import Redis from 'ioredis';
import {
  BidCreatedEventPayload,
  BidCreatedPubSubMessage,
  BidStatus,
} from './bid-log.types';
import { BidLogRepository } from './repositories/bid-log.repository.interface';
import { BidLogDataDto, BidLogItemDto } from './dto/bid-log-response.dto';
import { CampaignRepository } from 'src/campaign/repository/campaign.repository.interface';
import { BlogRepository } from 'src/blog/repository/blog.repository.interface';
import { MetricsService } from 'src/metrics/metrics.service';
import { IOREDIS_CLIENT } from 'src/redis/redis.constant';
import type { AppIORedisClient } from 'src/redis/redis.type';
import { BID_LOG_CREATED_CHANNEL } from './bid-log.constants';

@Injectable()
export class BidLogService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(BidLogService.name);
  private subscriber: Redis | null = null;

  constructor(
    private readonly bidLogRepository: BidLogRepository,
    private readonly campaignRepository: CampaignRepository,
    private readonly blogRepository: BlogRepository,
    private readonly eventEmitter: EventEmitter2,
    private readonly metricsService: MetricsService,
    @Inject(IOREDIS_CLIENT)
    private readonly ioRedisClient: AppIORedisClient
  ) {}

  async onModuleInit(): Promise<void> {
    try {
      this.subscriber = this.ioRedisClient.duplicate();
      await this.subscriber.subscribe(BID_LOG_CREATED_CHANNEL);

      this.subscriber.on('message', (channel, rawMessage) => {
        if (channel !== BID_LOG_CREATED_CHANNEL) {
          return;
        }

        this.handlePubSubMessage(rawMessage);
      });

      this.logger.log(
        `BidLog pub/sub 구독 시작: channel=${BID_LOG_CREATED_CHANNEL}`
      );
    } catch (error) {
      this.logger.error(
        'BidLog pub/sub 구독 초기화 실패',
        error instanceof Error ? error.stack : String(error)
      );
    }
  }

  async onModuleDestroy(): Promise<void> {
    if (!this.subscriber) {
      return;
    }

    await this.subscriber.unsubscribe(BID_LOG_CREATED_CHANNEL);
    this.subscriber.disconnect();
    this.subscriber = null;
  }

  async getRealtimeBidLogs(
    userId: number,
    limit: number,
    offset: number,
    startDate?: string,
    endDate?: string,
    campaignIds?: string[]
  ): Promise<BidLogDataDto> {
    const total = await this.bidLogRepository.countByUserId(
      userId,
      startDate,
      endDate,
      campaignIds
    );

    const bidLogs = await this.bidLogRepository.findByUserId(
      userId,
      limit,
      offset,
      'createdAt',
      'desc',
      startDate,
      endDate,
      campaignIds
    );

    // TODO(후순위): 쿼리 최적화 필요
    // DTO로 변환 (Campaign, Blog 조인)
    const dataPromises = bidLogs.map(async (log) => {
      // Campaign 정보 조회
      const campaign = await this.campaignRepository.getById(log.campaignId);
      // Blog 정보 조회
      const blog = await this.blogRepository.findById(log.blogId);
      // 낙찰가 조회
      const winAmount = await this.bidLogRepository.findWinAmountByAuctionId(
        log.auctionId
      );

      return {
        id: log.id!,
        createdAt: log.createdAt!, // Entity에서 자동생성됨
        campaignId: log.campaignId,
        campaignTitle: campaign?.title || 'Unknown Campaign',
        blogKey: blog?.blogKey || 'Unknown Blog Key',
        blogName: blog?.name || 'Unknown Blog',
        postUrl: log.postUrl || blog?.domain || 'unknown.com',
        bidAmount: log.bidPrice,
        winAmount: winAmount,
        isWon: log.status === BidStatus.WIN,
        isHighIntent: log.isHighIntent,
        behaviorScore: log.behaviorScore,
      };
    });

    const bids: BidLogItemDto[] = await Promise.all(dataPromises);

    const hasMore = offset + limit < total;

    return {
      total,
      hasMore,
      bids,
    };
  }

  // SSE: 실시간 입찰 이벤트 구독
  subscribeToBidEvents(userId: number): Observable<MessageEvent> {
    return new Observable((observer) => {
      const listener = (bid: BidLogItemDto) => {
        observer.next({
          data: JSON.stringify(bid),
        } as MessageEvent);
      };

      this.eventEmitter.on(`bid.created.${userId}`, listener);
      this.metricsService.incSseConnections('bidlog');
      return () => {
        this.eventEmitter.off(`bid.created.${userId}`, listener);
        this.metricsService.decSseConnections('bidlog');
      };
    });
  }

  // RTB에서 호출할 이벤트 발행 메서드
  emitBidCreated(payload: BidCreatedEventPayload): boolean {
    const { log, userId, campaignTitle, blogKey, blogName, winAmount } =
      payload;

    const bidData: BidLogItemDto = {
      id: log.id!,
      createdAt: log.createdAt!,
      campaignId: log.campaignId,
      campaignTitle,
      blogKey,
      blogName,
      postUrl: log.postUrl || 'unknown.com',
      bidAmount: log.bidPrice,
      winAmount: winAmount,
      isWon: log.status === BidStatus.WIN,
      isHighIntent: log.isHighIntent,
      behaviorScore: log.behaviorScore,
    };

    // userId별로 다른 이벤트 발행 (해당 광고주만 수신)
    return this.eventEmitter.emit(`bid.created.${userId}`, bidData);
  }

  private handlePubSubMessage(rawMessage: string): void {
    try {
      const message = JSON.parse(rawMessage) as BidCreatedPubSubMessage;

      if (!Array.isArray(message.events)) {
        this.metricsService.incBidlogPubSubMessage('invalid_format');
        this.logger.warn('BidLog pub/sub 메시지 형식이 올바르지 않습니다');
        return;
      }

      this.metricsService.incBidlogPubSubMessage('received');
      this.metricsService.observeBidlogPubSubBatchSize(message.events.length);
      const publishedAtMs = this.resolvePublishedAtMs(message.publishedAt);

      for (const event of message.events) {
        this.metricsService.incBidlogPubSubEvent('received');

        const hasListeners = this.emitBidCreated(event);
        this.metricsService.incBidlogPubSubEvent(
          hasListeners ? 'emitted' : 'no_listener'
        );

        if (publishedAtMs !== null) {
          this.metricsService.observeBidlogPubSubDeliveryLag(
            Date.now() - publishedAtMs
          );
        }
      }
    } catch (error) {
      this.metricsService.incBidlogPubSubMessage('parse_error');
      this.logger.error(
        'BidLog pub/sub 메시지 처리 실패',
        error instanceof Error ? error.stack : String(error)
      );
    }
  }

  private resolvePublishedAtMs(publishedAt?: string): number | null {
    if (!publishedAt) {
      return null;
    }

    const parsed = Date.parse(publishedAt);
    return Number.isFinite(parsed) ? parsed : null;
  }
}
