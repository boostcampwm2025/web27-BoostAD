import { Injectable, MessageEvent } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Observable } from 'rxjs';
import { BidStatus } from './bid-log.types';
import { BidLogRepository } from './repositories/bid-log.repository.interface';
import { BidLogDataDto, BidLogItemDto } from './dto/bid-log-response.dto';
import { CampaignRepository } from 'src/campaign/repository/campaign.repository.interface';
import { BlogRepository } from 'src/blog/repository/blog.repository.interface';
import { MetricsService } from 'src/metrics/metrics.service';

@Injectable()
export class BidLogService {
  constructor(
    private readonly bidLogRepository: BidLogRepository,
    private readonly campaignRepository: CampaignRepository,
    private readonly blogRepository: BlogRepository,
    private readonly eventEmitter: EventEmitter2,
    private readonly metricsService: MetricsService
  ) {}

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
  async emitBidCreated(bidLogId: number): Promise<void> {
    // BidLog 조회 및 DTO 변환
    // TODO: 매 hotpath 요청마다 emitBidCreated가 호출되고 Bidlog테이블 전체조회가 일어남, 제거필요
    const log = await this.bidLogRepository.findById(bidLogId);
    if (!log) return;

    const [campaign, blog, winAmount] = await Promise.all([
      this.campaignRepository.getById(log.campaignId),
      this.blogRepository.findById(log.blogId),
      this.bidLogRepository.findWinAmountByAuctionId(log.auctionId),
    ]);

    const bidData: BidLogItemDto = {
      id: log.id!,
      createdAt: log.createdAt!,
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

    // userId별로 다른 이벤트 발행 (해당 광고주만 수신)
    const userId = campaign?.userId || 0;
    this.eventEmitter.emit(`bid.created.${userId}`, bidData);
  }
}
