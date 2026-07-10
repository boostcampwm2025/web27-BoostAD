import { Injectable } from '@nestjs/common';
import { Matcher } from './matchers/matcher.interface';
import { CampaignSelector } from './selectors/selector.interface';
import type {
  DecisionContext,
  ScoredCandidate,
  SelectionResult,
} from './types/decision.types';
import { randomUUID } from 'crypto';
import { CacheRepository } from '../cache/repository/cache.repository.interface';
import { BidStatus } from '../bid-log/bid-log.types';
import { CampaignCacheRepository } from '../campaign/repository/campaign.cache.repository.interface';
import { MetricsService } from '../metrics/metrics.service';
import {
  createRtbPathLogger,
  rtbPathLogsEnabled,
} from '../common/logging/rtb-path-logger.util';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { BidLogJobData } from '../queue/types/queue.type';
import { ConfigService } from '@nestjs/config';

type BudgetMode = 'legacy_topk' | 'winner_only';

@Injectable()
export class RTBService {
  private readonly logger = createRtbPathLogger(RTBService.name);
  private readonly logsEnabled = rtbPathLogsEnabled();
  private readonly FALLBACK_CAMPAIGN_ID =
    'c1dda7a5-da58-416b-b8fa-20ba8f5535f9';
  private readonly TOP_K = 10;
  private readonly budgetMode: BudgetMode;

  constructor(
    private readonly matcher: Matcher,
    private readonly selector: CampaignSelector,
    private readonly cacheRepository: CacheRepository,
    private readonly campaignCacheRepository: CampaignCacheRepository,
    private readonly metricsService: MetricsService,
    @InjectQueue('bidlog-queue')
    private readonly bidlogQueue: Queue<BidLogJobData>,
    private readonly configService: ConfigService
  ) {
    this.budgetMode = this.resolveBudgetMode(
      this.configService.get<string>('RTB_BUDGET_MODE', 'legacy_topk')
    );
  }

  async runAuction(context: DecisionContext) {
    const totalStartedAt = process.hrtime.bigint();
    let requestResult: 'success' | 'error' | 'fallback' = 'success';
    let totalOutcome: 'ok' | 'error' | 'fallback' = 'ok';
    let fallbackUsed = false;

    try {
      const auctionId = randomUUID();

      // 0. blogId는 Guard에서 이미 검증됨 (중복 조회 제거)
      const blogId = context.blogId;

      // 1. 후보 불러오기 및 필터링 + 점수 계산
      let candidates: ScoredCandidate[] = await this.measureStage('match', () =>
        this.matcher.findCandidatesByTags(context)
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
                similarity: 0,
                score: fallbackCampaign.maxCpc * 0.3,
                ...fallbackCampaign,
              },
            ];
          },
          'fallback'
        );
      }

      this.metricsService.observeRtbMatchedBeforeReserveCount(
        candidates.length
      );

      const result =
        this.budgetMode === 'winner_only'
          ? await this.runWinnerOnlyReservation(candidates)
          : await this.runLegacyTopKReservation(auctionId, candidates);

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

  private async runWinnerOnlyReservation(
    candidates: ScoredCandidate[]
  ): Promise<SelectionResult> {
    const ranked = await this.measureStage('select', () =>
      this.selector.selectWinner(candidates)
    );
    const winner = await this.measureStage('reserve', () =>
      this.reserveFirstRankedCandidate(ranked.candidates)
    );

    if (!winner) {
      throw new Error('예산 확보 가능한 캠페인이 없습니다');
    }

    this.metricsService.observeRtbRollbackCandidateCount(0);
    return { winner, candidates: [winner] };
  }

  private async runLegacyTopKReservation(
    auctionId: string,
    candidates: ScoredCandidate[]
  ): Promise<SelectionResult> {
    const reservedCandidates = await this.measureStage('reserve', () =>
      this.reserveCandidatesByTopKWindow(candidates)
    );

    if (reservedCandidates.length === 0) {
      throw new Error('예산 확보 가능한 캠페인이 없습니다');
    }

    const result = await this.measureStage('select', () =>
      this.selector.selectWinner(reservedCandidates)
    );
    await this.measureStage('rollback', () =>
      this.rollbackLosersSpent(auctionId, result)
    );
    return result;
  }

  private async rollbackLosersSpent(
    auctionId: string,
    result: SelectionResult
  ) {
    const losers = result.candidates.filter(
      (candidate) => candidate.id !== result.winner.id
    );
    this.metricsService.observeRtbRollbackCandidateCount(losers.length);

    // legacy top-K window는 최대 10개이므로 window 내부에서 병렬 처리
    await Promise.allSettled(
      losers.map(async (loser) => {
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
    );
  }
  /**
   * 예산증액에 성공한 캠페인들 반환
   */
  private async increaseSpentCandidates(
    candidates: ScoredCandidate[]
  ): Promise<ScoredCandidate[]> {
    const eligibleCandidates: ScoredCandidate[] = [];

    await Promise.allSettled(
      candidates.map(async (candidate) => {
        const { id, maxCpc, dailyBudget, totalBudget } = candidate;
        const dependencyStartedAt = process.hrtime.bigint();
        const reserved = await this.campaignCacheRepository.incrementSpent(
          id,
          maxCpc,
          dailyBudget,
          totalBudget
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
            this.logger.debug(`캠페인 ${id} 예산 확보 실패 - 후보에서 제외`);
          }
        }
      })
    );

    return eligibleCandidates;
  }

  private async reserveFirstRankedCandidate(
    rankedCandidates: ScoredCandidate[]
  ): Promise<ScoredCandidate | null> {
    let attemptedCandidateCount = 0;
    let attemptedWindowCount = 0;

    for (let start = 0; start < rankedCandidates.length; start += this.TOP_K) {
      attemptedWindowCount += 1;
      const window = rankedCandidates.slice(start, start + this.TOP_K);
      const dependencyStartedAt = process.hrtime.bigint();
      const reserved = await this.campaignCacheRepository.reserveFirstAvailable(
        window.map((candidate) => ({
          campaignId: candidate.id,
          cpc: candidate.maxCpc,
        }))
      );
      const checkedInWindow = reserved?.attemptedCount ?? window.length;
      attemptedCandidateCount += checkedInWindow;

      this.metricsService.recordDependency(
        'redis',
        'reserve_first_available',
        reserved ? 'ok' : 'rejected',
        this.elapsedMs(dependencyStartedAt)
      );
      this.metricsService.incRtbReservationFailure(
        'rejected',
        reserved ? Math.max(0, checkedInWindow - 1) : checkedInWindow
      );

      if (reserved) {
        const winner = window.find(
          (candidate) => candidate.id === reserved.campaignId
        );
        if (!winner) {
          throw new Error(
            'winner-only 예약 결과가 후보 window와 일치하지 않습니다'
          );
        }
        this.recordWinnerOnlyFanout(
          attemptedWindowCount,
          attemptedCandidateCount,
          1
        );
        return winner;
      }
    }

    this.recordWinnerOnlyFanout(
      attemptedWindowCount,
      attemptedCandidateCount,
      0
    );
    return null;
  }

  private recordWinnerOnlyFanout(
    attemptedWindowCount: number,
    attemptedCandidateCount: number,
    reservedCandidateCount: 0 | 1
  ): void {
    this.metricsService.observeRtbReserveWindowAttemptCount(
      attemptedWindowCount
    );
    this.metricsService.observeRtbReserveAttemptCandidateCount(
      attemptedCandidateCount
    );
    this.metricsService.observeRtbReservedCandidateCount(
      reservedCandidateCount
    );
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

  private async reserveCandidatesByTopKWindow(
    candidates: ScoredCandidate[]
  ): Promise<ScoredCandidate[]> {
    const sortedCandidates = this.sortCandidatesByScoreDesc(candidates);
    let attemptedWindowCount = 0;
    let attemptedCandidateCount = 0;

    for (let start = 0; start < sortedCandidates.length; start += this.TOP_K) {
      attemptedWindowCount += 1;
      const candidateWindow = sortedCandidates.slice(start, start + this.TOP_K);
      attemptedCandidateCount += candidateWindow.length;
      const reservedCandidates =
        await this.increaseSpentCandidates(candidateWindow);

      if (reservedCandidates.length > 0) {
        this.metricsService.observeRtbReserveWindowAttemptCount(
          attemptedWindowCount
        );
        this.metricsService.observeRtbReserveAttemptCandidateCount(
          attemptedCandidateCount
        );
        this.metricsService.observeRtbReservedCandidateCount(
          reservedCandidates.length
        );
        return reservedCandidates;
      }
    }

    this.metricsService.observeRtbReserveWindowAttemptCount(
      attemptedWindowCount
    );
    this.metricsService.observeRtbReserveAttemptCandidateCount(
      attemptedCandidateCount
    );
    this.metricsService.observeRtbReservedCandidateCount(0);

    return [];
  }

  private sortCandidatesByScoreDesc(
    candidates: ScoredCandidate[]
  ): ScoredCandidate[] {
    return [...candidates].sort((a, b) => b.score - a.score);
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

  private resolveBudgetMode(configuredMode: string | undefined): BudgetMode {
    if (configuredMode === 'winner_only') {
      return 'winner_only';
    }
    if (configuredMode && configuredMode !== 'legacy_topk') {
      this.logger.warn(
        `지원하지 않는 RTB_BUDGET_MODE=${configuredMode}; legacy_topk를 사용합니다.`
      );
    }
    return 'legacy_topk';
  }
}
