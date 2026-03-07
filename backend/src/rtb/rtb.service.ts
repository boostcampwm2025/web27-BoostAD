import { Injectable } from '@nestjs/common';
import { Matcher } from './matchers/matcher.interface';
import { Scorer } from './scorers/scorer.interface';
import { CampaignSelector } from './selectors/selector.interface';
import type {
  Candidate,
  DecisionContext,
  ScoredCandidate,
  SelectionResult,
} from './types/decision.types';
import { randomUUID } from 'crypto';
import { BidLogRepository } from '../bid-log/repositories/bid-log.repository.interface';
import { BidLogService } from '../bid-log/bid-log.service';
import { CacheRepository } from '../cache/repository/cache.repository.interface';
import { BidStatus } from '../bid-log/bid-log.types';
import { BlogRepository } from '../blog/repository/blog.repository.interface';
import { CampaignCacheRepository } from '../campaign/repository/campaign.cache.repository.interface';
import pLimit from 'p-limit';
import { MetricsService } from '../metrics/metrics.service';
import {
  createRtbPathLogger,
  rtbPathLogsEnabled,
} from '../common/logging/rtb-path-logger.util';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { BidLogJobData } from '../queue/types/queue.type';

@Injectable()
export class RTBService {
  private readonly logger = createRtbPathLogger(RTBService.name);
  private readonly logsEnabled = rtbPathLogsEnabled();
  private readonly FALLBACK_CAMPAIGN_ID =
    'c1dda7a5-da58-416b-b8fa-20ba8f5535f9';
  private readonly BATCH_LIMIT = 10;
  private readonly limit = pLimit(this.BATCH_LIMIT);

  constructor(
    private readonly matcher: Matcher,
    private readonly scorer: Scorer,
    private readonly selector: CampaignSelector,
    private readonly bidLogRepository: BidLogRepository,
    private readonly bidLogService: BidLogService,
    private readonly cacheRepository: CacheRepository,
    private readonly blogRepository: BlogRepository,
    private readonly campaignCacheRepository: CampaignCacheRepository,
    private readonly metricsService: MetricsService,
    @InjectQueue('bidlog-queue')
    private readonly bidlogQueue: Queue<BidLogJobData>
  ) {}

  async runAuction(context: DecisionContext) {
    const totalStartedAt = process.hrtime.bigint();
    let requestResult: 'success' | 'error' | 'fallback' = 'success';
    let totalOutcome: 'ok' | 'error' | 'fallback' = 'ok';
    let fallbackUsed = false;

    try {
      const auctionId = randomUUID();

      // 0. blogId는 Guard에서 이미 검증됨 (중복 조회 제거)
      const blogId = context.blogId;

      // 1. 후보 불러오기 및 필터링
      // TODO(추후 고려 사항): 여기서도 embedding, deleteAt,active, isHighIntent 속성 반환이 필요한가? -> 아 bidLog기록을 위해서는 isHighIntent 속성은 필요할 거 같음
      let candidates: Candidate[] = await this.measureStage('match', () =>
        this.matcher.findCandidatesByTags(context)
      );

      // -------- 여기부터 병목 후보 ------------------

      // 2. 선제적 Spent 증가
      candidates = await this.measureStage('reserve', () =>
        this.increaseSpentCandidates(candidates)
      );

      // 후보가 없으면 fallback 캠페인 조회 (캐시에서)
      if (candidates.length === 0) {
        fallbackUsed = true;
        this.metricsService.incRtbFallback('no_candidates');
        if (this.logsEnabled) {
          this.logger.warn(
            `후보가 없습니다. Fallback 캠페인 조회: ${this.FALLBACK_CAMPAIGN_ID}`
          );
        }

        candidates = await this.measureStage(
          'fallback_lookup',
          async () => {
            const fallbackCampaign = await this.measureDependency(
              'redis',
              'find_fallback_campaign',
              () =>
                this.campaignCacheRepository.findCampaignCacheById(
                  this.FALLBACK_CAMPAIGN_ID
                )
            );

            if (!fallbackCampaign) {
              throw new Error('Fallback 캠페인을 찾을 수 없습니다');
            }

            return [
              {
                campaign: fallbackCampaign,
                similarity: 0,
              },
            ];
          },
          'fallback'
        );
      }
      // 3. 유사도 점수 계산
      this.metricsService.observeRtbCandidateCount(candidates.length);
      const scored: ScoredCandidate[] = await this.measureStage('score', () =>
        this.scorer.scoreCandidates(candidates)
      );

      // 4. 경매에 참여한 캠페인들에 대해 승자 도출, 전체결과 반환
      const result = await this.measureStage('select', () =>
        this.selector.selectWinner(scored)
      );

      // 5. 패배한 캠페인들의 Spent 롤백
      await this.measureStage('rollback', () =>
        this.rollbackLosersSpent(auctionId, result)
      );

      // 6. AuctionStore에 경매 데이터 저장 (ViewLog에서 조회용)
      await this.measureStage('cache_auction', () =>
        this.measureDependency('redis', 'set_auction_data', () =>
          this.cacheRepository.setAuctionData(auctionId, {
            blogId: blogId,
            cost: result.winner.maxCpc,
          })
        )
      );

      // 7. BidLog 저장 (모든 참여 캠페인의 입찰 기록)
      // TODO(추후 고려 사항): 속성값 고민 및 reason 필드에 대한 고민 그리고 로그 데이터는 RedisStream으로 큐를 통한 배치처리가 고려되면 좋을 거 같음
      // const bidLogs: BidLog[] = result.candidates.map((candidate) => ({
      //   auctionId,
      //   campaignId: candidate.id,
      //   blogId: blogId,
      //   status:
      //     candidate.id === result.winner.id ? BidStatus.WIN : BidStatus.LOSS,
      //   bidPrice: candidate.maxCpc,
      //   isHighIntent: context.isHighIntent,
      //   behaviorScore: context.behaviorScore,
      //   postUrl: context.postUrl,
      //   reason: '', // 추후에 수정 필요
      // }));

      const bidLogJob: BidLogJobData = {
        auctionId,
        blogId: blogId,
        isHighIntent: context.isHighIntent,
        behaviorScore: context.behaviorScore,
        postUrl: context.postUrl,
        blogKey: context.blogKey,
        blogName: context.blogName,
        winAmount: result.winner.maxCpc,
        items: result.candidates.map((candidate) => ({
          campaignId: candidate.id,
          status:
            candidate.id === result.winner.id ? BidStatus.WIN : BidStatus.LOSS,
          bidPrice: candidate.maxCpc,
          reason: '', // 추후에 수정 필요
          userId: candidate.userId,
          campaignTitle: candidate.title,
        })),
      };

      this.metricsService.observeRtbBidLogCount(bidLogJob.items.length);
      await this.bidlogQueue.add('save-bidlog', bidLogJob);

      requestResult = fallbackUsed ? 'fallback' : 'success';
      totalOutcome = fallbackUsed ? 'fallback' : 'ok';

      return {
        status: 'success',
        message: '광고 선정 완료',
        data: {
          auctionId,
          campaign: { ...result.winner },
          candidates: result.candidates,
        },
        timestamp: new Date().toISOString(),
      };
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);

      requestResult = 'error';
      totalOutcome = 'error';

      if (this.logsEnabled) {
        this.logger.warn(`Auction 실패: ${errorMessage}`);
      }

      // 에러 발생 시(예: 후보 없음) null winner와 빈 리스트를 반환하여 정상 응답 처리

      // message와 error 필드에 대해서는 추후에 통일된 에러 헨들링 전략 사용이 용이할 거 같음
      return {
        status: 'error',
        message: 'error message',
        data: null,
        errors: [
          {
            field: 'field',
            message: 'error message',
          },
        ],
        timestamp: new Date().toISOString(),
      };
    } finally {
      this.metricsService.recordRtbStage(
        'total',
        totalOutcome,
        this.elapsedMs(totalStartedAt)
      );
      this.metricsService.recordRtbRequest(requestResult, context.isHighIntent);
    }
  }

  private async rollbackLosersSpent(
    auctionId: string,
    result: SelectionResult
  ) {
    const losers = result.candidates.filter(
      (candidate) => candidate.id !== result.winner.id
    );

    // 병렬 처리 - p-limit 사용
    await Promise.allSettled(
      losers.map((loser) =>
        this.limit(async () => {
          const dependencyStartedAt = process.hrtime.bigint();

          try {
            await this.campaignCacheRepository.decrementSpent(
              loser.id,
              loser.maxCpc
            );
            this.metricsService.recordDependency(
              'redis',
              'decrement_spent',
              'ok',
              this.elapsedMs(dependencyStartedAt)
            );
            if (this.logsEnabled) {
              this.logger.debug(
                `Auction ${auctionId}: 패배 캠페인 ${loser.id} Spent 롤백 완료`
              );
            }
          } catch (error) {
            this.metricsService.recordDependency(
              'redis',
              'decrement_spent',
              'error',
              this.elapsedMs(dependencyStartedAt)
            );
            if (this.logsEnabled) {
              this.logger.warn(
                `Auction ${auctionId}: 패배 캠페인 ${loser.id} Spent 롤백 실패`,
                error
              );
            }
          }
        })
      )
    );
  }
  /**
   * 예산증액에 성공한 캠페인들 반환
   */
  private async increaseSpentCandidates(candidates: Candidate[]) {
    const eligibleCandidates: Candidate[] = [];

    await Promise.allSettled(
      candidates.map((candidate) =>
        this.limit(async () => {
          const { campaign } = candidate;
          const dependencyStartedAt = process.hrtime.bigint();
          const reserved = await this.campaignCacheRepository.incrementSpent(
            campaign.id,
            campaign.maxCpc,
            campaign.dailyBudget,
            campaign.totalBudget
          );

          this.metricsService.recordDependency(
            'redis',
            'increment_spent',
            reserved ? 'ok' : 'rejected',
            this.elapsedMs(dependencyStartedAt)
          );

          if (reserved) {
            eligibleCandidates.push(candidate);
          } else {
            this.metricsService.incRtbReservationFailure('rejected');
            if (this.logsEnabled) {
              this.logger.debug(
                `캠페인 ${campaign.id} 예산 확보 실패 - 후보에서 제외`
              );
            }
          }
        })
      )
    );

    return eligibleCandidates;
  }

  private elapsedMs(startedAt: bigint): number {
    return Number(process.hrtime.bigint() - startedAt) / 1_000_000;
  }

  private async measureStage<T>(
    stage: string,
    fn: () => Promise<T>,
    successOutcome: 'ok' | 'fallback' = 'ok'
  ): Promise<T> {
    const startedAt = process.hrtime.bigint();

    try {
      const result = await fn();
      this.metricsService.recordRtbStage(
        stage,
        successOutcome,
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
    fn: () => Promise<T>
  ): Promise<T> {
    const startedAt = process.hrtime.bigint();

    try {
      const result = await fn();
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

  // cache 문제로 인한 무의미한 주석
  // 경매 참여 가능한 캠페인만 필터링
  // private filterEligibleCampaigns(candidates: Candidate[]): Candidate[] {
  //   const now = new Date();

  //   return candidates.filter((candidate) => {
  //     const campaign = candidate.campaign;

  //     // 삭제된 캠페인 제외
  //     if (campaign.deletedAt) {
  //       return false;
  //     }

  //     // ACTIVE 상태만 허용
  //     if (campaign.status !== 'ACTIVE') {
  //       return false;
  //     }

  //     // 날짜 범위 검증
  //     const startDate = new Date(campaign.startDate);
  //     const endDate = new Date(campaign.endDate);

  //     if (now < startDate || now >= endDate) {
  //       return false;
  //     }

  //     return true;
  //   });
  // }
}
