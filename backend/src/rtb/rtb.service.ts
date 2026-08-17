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
import { toServingCampaign } from '../campaign/serving-campaign';
import { createCandidate } from './candidate.factory';
import { MetricsService } from '../metrics/metrics.service';
import {
  createRtbPathLogger,
  rtbPathLogsEnabled,
} from '../common/logging/rtb-path-logger.util';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { BidLogJobData } from '../queue/types/queue.type';
import { ConfigService } from '@nestjs/config';
import { AUCTION_RESERVATION_TTL_MS } from '../campaign/constants/auction-reservation.constants';
import type { ActiveAuctionReservation } from '../campaign/types/campaign.types';

type BudgetMode = 'legacy_topk' | 'winner_only';

@Injectable()
export class RTBService {
  private readonly logger = createRtbPathLogger(RTBService.name);
  private readonly logsEnabled = rtbPathLogsEnabled();
  private readonly FALLBACK_CAMPAIGN_ID =
    'c1dda7a5-da58-416b-b8fa-20ba8f5535f9';
  private readonly TOP_K = 10;
  private readonly budgetMode: BudgetMode;
  private readonly auctionReservationTtlMs: number;

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
    this.auctionReservationTtlMs = this.getPositiveIntConfig(
      'RTB_AUCTION_RESERVATION_TTL_MS',
      AUCTION_RESERVATION_TTL_MS
    );
  }

  /**
   * RTB 경매의 전체 오케스트레이션 진입점.
   * 후보 매칭 → fallback 보완 → 예산 예약 → 경매 캐시/입찰 로그 저장 → 응답 생성을 순서대로 수행한다.
   */
  async runAuction(context: DecisionContext) {
    // [0. 요청 결과 추적 초기화]
    // finally에서 경로별 지연 시간과 success/error/fallback 결과를 공통 기록한다.
    const totalStartedAt = process.hrtime.bigint();
    let requestResult: 'success' | 'error' | 'fallback' = 'success';
    let totalOutcome: 'ok' | 'error' | 'fallback' = 'ok';
    let fallbackUsed = false;

    try {
      // [1. 경매 식별자와 검증된 요청 컨텍스트 준비]
      // blogId는 진입 전 Guard에서 검증됐으므로 여기서는 중복 조회하지 않는다.
      const auctionId = randomUUID();
      const blogId = context.blogId;

      // [2. 캠페인 후보 매칭]
      // matcher가 ANN/lexical 설정에 따라 후보를 조회하고 집행 조건 필터링과 점수 계산까지 수행한다.
      // 이 단계에서는 아직 캠페인 예산을 예약하지 않는다.
      let candidates: ScoredCandidate[] = await this.measureStage('match', () =>
        this.matcher.matchCandidates(context)
      );

      // [분기 A: 매칭 후보 없음 → 고정 fallback 캠페인 보완]
      // 예약 실패가 아니라 matcher 결과가 비었을 때만 fallback 캠페인을 후보로 주입한다.
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

            const candidate = createCandidate(
              toServingCampaign(fallbackCampaign),
              0
            );

            // fallback은 의미 유사도 없이 CPC 가중치만 반영하고 이후 동일한 예산 예약 경로를 탄다.
            return [
              {
                ...candidate,
                score: fallbackCampaign.maxCpc * 0.3,
              },
            ];
          },
          'fallback'
        );
      }

      // [3. 예산 예약 방식 선택]
      // fallback을 포함한 최종 후보 수를 기록한 뒤 설정된 budget mode로 winner를 확정한다.
      this.metricsService.observeRtbMatchedBeforeReserveCount(
        candidates.length
      );

      const result =
        this.budgetMode === 'winner_only'
          ? await this.runWinnerOnlyReservation(auctionId, blogId, candidates)
          : await this.runLegacyTopKReservation(auctionId, candidates);

      // [4. legacy 경매 결과 캐시 저장]
      // winner_only는 예약 Lua가 같은 auction 키에 versioned 예약 정보를 이미 저장한다.
      if (this.budgetMode === 'legacy_topk') {
        await this.measureStage('cache_auction', () =>
          this.measureDependency('redis', 'set_auction_data', () =>
            this.cacheRepository.setAuctionData(auctionId, {
              blogId: blogId,
              cost: result.winner.maxCpc,
            })
          )
        );
      }

      // [5. 입찰 로그 작업 생성]
      // 예산 모드가 반환한 후보 목록을 winner/loser 상태로 변환해 비동기 저장 큐에 넣는다.
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

      // [6. 성공 결과 분류]
      // fallback 캠페인이 낙찰돼도 API 응답은 success이며 메트릭 결과만 fallback으로 구분한다.
      requestResult = fallbackUsed ? 'fallback' : 'success';
      totalOutcome = fallbackUsed ? 'fallback' : 'ok';

      // [정상 종료: 낙찰 캠페인과 경매 후보 반환]
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
      // [오류 종료]
      // fallback 조회 실패, 예산 확보 실패, Redis/Queue 오류 등 경매 중 발생한 예외를 공통 처리한다.
      const errorMessage =
        error instanceof Error ? error.message : String(error);

      requestResult = 'error';
      totalOutcome = 'error';

      if (this.logsEnabled) {
        this.logger.warn(`Auction 실패: ${errorMessage}`);
      }

      // 현재 계약은 예외를 다시 던지지 않고 status:error와 data:null 응답으로 변환한다.
      // message/errors의 임시 문자열은 추후 공통 에러 처리 정책에서 구체화할 대상이다.
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
      // [공통 종료 처리]
      // 정상·fallback·오류 여부와 관계없이 전체 지연 시간과 최종 요청 결과를 기록한다.
      this.metricsService.recordRtbStage(
        'total',
        totalOutcome,
        this.elapsedMs(totalStartedAt)
      );
      this.metricsService.recordRtbRequest(requestResult, context.isHighIntent);
    }
  }

  /**
   * winner-only 예산 예약 흐름.
   * 점수순으로 후보를 정렬한 뒤 예산 확보가 가능한 첫 캠페인 하나만 예약한다.
   */
  private async runWinnerOnlyReservation(
    auctionId: string,
    blogId: number,
    candidates: ScoredCandidate[]
  ): Promise<SelectionResult> {
    // [1. 후보 순위 확정]
    // score → maxCpc → 완전 동점 시 랜덤 순서로 예산 예약 우선순위를 만든다.
    const ranked = await this.measureStage('select', () =>
      this.selector.rankCandidates(candidates)
    );

    // [2. winner 한 건 예약]
    // 정렬된 순서대로 확인하며 예산 확보가 가능한 첫 캠페인에서 탐색을 종료한다.
    const winner = await this.measureStage('reserve', () =>
      this.reserveFirstRankedCandidate(auctionId, blogId, ranked.candidates)
    );

    // [종료 분기: 모든 후보의 예산 확보 실패]
    if (!winner) {
      throw new Error('예산 확보 가능한 캠페인이 없습니다');
    }

    // [3. 최종 결과 반환]
    // winner-only는 패자 예산을 선점하지 않았으므로 롤백 대상이 없다.
    this.metricsService.observeRtbRollbackCandidateCount(0);
    return { winner, candidates: [winner] };
  }

  /**
   * legacy top-K 예산 예약 흐름.
   * 점수 상위 window의 캠페인들을 함께 예약하고 winner를 고른 뒤 패자 예약을 롤백한다.
   */
  private async runLegacyTopKReservation(
    auctionId: string,
    candidates: ScoredCandidate[]
  ): Promise<SelectionResult> {
    // [1. Top-K window 예약]
    // 점수순 window 안의 후보를 병렬 예약하고, 한 건 이상 성공한 첫 window만 사용한다.
    const reservedCandidates = await this.measureStage('reserve', () =>
      this.reserveCandidatesByTopKWindow(candidates)
    );

    // [종료 분기: 모든 window의 예산 확보 실패]
    if (reservedCandidates.length === 0) {
      throw new Error('예산 확보 가능한 캠페인이 없습니다');
    }

    // [2. 예약 성공 후보의 winner 확정]
    // 병렬 예약 완료 순서는 순위를 보장하지 않으므로 성공 후보를 다시 정렬한다.
    const result = await this.measureStage('select', () =>
      this.selector.rankCandidates(reservedCandidates)
    );

    // [3. 패자 예약 롤백]
    // 최종 winner를 제외한 캠페인에 선반영된 spent를 원복한다.
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
        const { id, maxCpc } = candidate;
        const dependencyStartedAt = process.hrtime.bigint();
        const reserved = await this.campaignCacheRepository.incrementSpent(
          id,
          maxCpc
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
    auctionId: string,
    blogId: number,
    rankedCandidates: ScoredCandidate[]
  ): Promise<ScoredCandidate | null> {
    // [1. 탐색량 집계 초기화]
    let attemptedCandidateCount = 0;
    let attemptedWindowCount = 0;
    const nowMs = Date.now();
    const budgetDate = this.getKstBudgetDate(nowMs);
    const expiresAt = Math.min(
      nowMs + this.auctionReservationTtlMs,
      this.getNextKstMidnightEpochMs(nowMs)
    );

    // [2. 순위 후보를 Top-K window 단위로 탐색]
    // 한 window가 모두 소진됐을 때만 다음 순위 window로 이동한다.
    for (let start = 0; start < rankedCandidates.length; start += this.TOP_K) {
      attemptedWindowCount += 1;
      const window = rankedCandidates.slice(start, start + this.TOP_K);
      const dependencyStartedAt = process.hrtime.bigint();

      // [2-1. 현재 window 예약]
      // Redis가 전달된 순서대로 검사하고 예산 확보가 가능한 첫 캠페인 하나만 예약한다.
      const reserved = await this.campaignCacheRepository.reserveAuction({
        auctionId,
        blogId,
        budgetDate,
        expiresAt,
        candidates: window.map((candidate) => ({
          campaignId: candidate.id,
          cpc: candidate.maxCpc,
        })),
      });
      const checkedInWindow = reserved.attemptedCount;
      attemptedCandidateCount += checkedInWindow;
      const reservationSucceeded =
        reserved.outcome === 'reserved' || reserved.outcome === 'existing';

      this.metricsService.recordDependency(
        'redis',
        'reserve_auction',
        reservationSucceeded ? 'ok' : 'rejected',
        this.elapsedMs(dependencyStartedAt)
      );
      this.metricsService.incRtbReservationFailure(
        'rejected',
        reservationSucceeded
          ? Math.max(0, checkedInWindow - 1)
          : checkedInWindow
      );

      // [성공 분기: 예약된 ID를 원본 후보 객체로 복원]
      if (reservationSucceeded) {
        const reservation = reserved.reservation;
        if (!this.isActiveReservation(reservation)) {
          throw new Error('winner-only 예약 상태가 이미 종료되었습니다');
        }
        const winner = rankedCandidates.find(
          (candidate) => candidate.id === reservation.campaignId
        );

        // Redis 결과와 현재 window가 어긋나면 잘못된 winner를 반환하지 않고 중단한다.
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

      if (reserved.outcome === 'conflict') {
        throw new Error('auctionId가 기존 legacy 경매 데이터와 충돌했습니다');
      }
    }

    // [종료 분기: 전체 후보 소진]
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

  private isActiveReservation(
    reservation: unknown
  ): reservation is ActiveAuctionReservation {
    return (
      typeof reservation === 'object' &&
      reservation !== null &&
      'status' in reservation &&
      reservation.status === 'RESERVED' &&
      'campaignId' in reservation &&
      typeof reservation.campaignId === 'string'
    );
  }

  private getPositiveIntConfig(name: string, fallback: number): number {
    const parsed = Number(this.configService.get<string>(name));
    return Number.isFinite(parsed) && parsed > 0
      ? Math.floor(parsed)
      : fallback;
  }

  private getKstBudgetDate(epochMs: number): string {
    return new Date(epochMs + 9 * 60 * 60 * 1000).toISOString().slice(0, 10);
  }

  private getNextKstMidnightEpochMs(epochMs: number): number {
    const shifted = new Date(epochMs + 9 * 60 * 60 * 1000);
    return (
      Date.UTC(
        shifted.getUTCFullYear(),
        shifted.getUTCMonth(),
        shifted.getUTCDate() + 1
      ) -
      9 * 60 * 60 * 1000
    );
  }
}
