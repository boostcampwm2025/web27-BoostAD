import { ConfigService } from '@nestjs/config';
import { CacheRepository } from 'src/cache/repository/cache.repository.interface';
import { CampaignCacheRepository } from 'src/campaign/repository/campaign.cache.repository.interface';
import type {
  ReserveAuctionRequest,
  ReserveAuctionResult,
} from 'src/campaign/types/campaign.types';
import { MetricsService } from 'src/metrics/metrics.service';
import type { BidLogJobData } from 'src/queue/types/queue.type';
import { Queue } from 'bullmq';
import { Matcher } from './matchers/matcher.interface';
import { CampaignSelector } from './selectors/selector.interface';
import { RTBService } from './rtb.service';
import type {
  DecisionContext,
  ScoredCandidate,
  SelectionResult,
} from './types/decision.types';

type ReserveAuctionMock = jest.Mock<
  Promise<ReserveAuctionResult>,
  [ReserveAuctionRequest]
>;

type IncrementSpentMock = jest.Mock<Promise<boolean>, [string, number]>;

type RepositoryMocks = {
  incrementSpent: IncrementSpentMock;
  reserveAuction: ReserveAuctionMock;
  decrementSpent: jest.Mock<Promise<void>, [string, number]>;
  findCampaignCacheById: jest.Mock;
};

type MetricMocks = {
  incRtbFallback: jest.Mock;
  observeRtbMatchedBeforeReserveCount: jest.Mock;
  observeRtbReserveWindowAttemptCount: jest.Mock;
  observeRtbReserveAttemptCandidateCount: jest.Mock;
  observeRtbReservedCandidateCount: jest.Mock;
  observeRtbRollbackCandidateCount: jest.Mock;
  recordDependency: jest.Mock;
  incRtbReservationFailure: jest.Mock;
  recordRtbStage: jest.Mock;
  observeRtbBidLogCount: jest.Mock;
  recordRtbRequest: jest.Mock;
};

type Harness = {
  service: RTBService;
  repositoryMocks: RepositoryMocks;
  metricMocks: MetricMocks;
  bidlogAdd: jest.Mock<Promise<void>, [string, BidLogJobData]>;
  cacheSetAuctionData: jest.Mock;
};

describe('RTBService winner-only reservation', () => {
  const context: DecisionContext = {
    blogKey: 'blog-key',
    blogId: 1,
    blogName: 'blog',
    tags: ['typescript'],
    postUrl: 'https://example.com/post',
    behaviorScore: 50,
    isHighIntent: false,
  };

  const buildCandidate = (
    id: string,
    score: number,
    overrides: Partial<ScoredCandidate> = {}
  ): ScoredCandidate => ({
    id,
    userId: 1,
    title: id,
    content: 'content',
    image: null,
    url: 'https://example.com/ad',
    maxCpc: 10,
    isHighIntent: false,
    status: 'ACTIVE',
    startDate: new Date(Date.now() - 1000).toISOString(),
    endDate: new Date(Date.now() + 60_000).toISOString(),
    deletedAt: null,
    tags: ['typescript'],
    similarity: 0.9,
    score,
    ...overrides,
  });

  const buildHarness = (
    candidates: ScoredCandidate[],
    options: {
      mode?: 'winner_only' | 'legacy_topk';
      incrementSpent?: IncrementSpentMock;
      reserveAuction?: ReserveAuctionMock;
    } = {}
  ): Harness => {
    const matcher = {
      matchCandidates: jest.fn().mockResolvedValue(candidates),
    } as unknown as Matcher;
    const selector = {
      rankCandidates: jest.fn<Promise<SelectionResult>, [ScoredCandidate[]]>(
        (input) => {
          const ranked = [...input].sort((a, b) => {
            if (b.score !== a.score) return b.score - a.score;
            if (b.maxCpc !== a.maxCpc) return b.maxCpc - a.maxCpc;
            return a.id.localeCompare(b.id);
          });
          return Promise.resolve({ winner: ranked[0], candidates: ranked });
        }
      ),
    } as unknown as CampaignSelector & { rankCandidates: jest.Mock };
    const cacheRepository = {
      setAuctionData: jest.fn().mockResolvedValue(undefined),
    } as unknown as CacheRepository & { setAuctionData: jest.Mock };
    const repositoryMocks: RepositoryMocks = {
      incrementSpent:
        options.incrementSpent ??
        jest.fn<Promise<boolean>, [string, number]>().mockResolvedValue(true),
      reserveAuction:
        options.reserveAuction ??
        jest
          .fn<Promise<ReserveAuctionResult>, [ReserveAuctionRequest]>()
          .mockImplementation((request) => {
            const winner = request.candidates[0];
            return Promise.resolve({
              outcome: 'reserved',
              attemptedCount: 1,
              reservation: {
                version: 1,
                auctionId: request.auctionId,
                campaignId: winner.campaignId,
                blogId: request.blogId,
                cost: winner.cpc,
                status: 'RESERVED',
                budgetDate: request.budgetDate,
                createdAt: 1,
                updatedAt: 1,
                expiresAt: request.expiresAt,
              },
            });
          }),
      decrementSpent: jest
        .fn<Promise<void>, [string, number]>()
        .mockResolvedValue(undefined),
      findCampaignCacheById: jest.fn(),
    };
    const campaignCacheRepository =
      repositoryMocks as unknown as CampaignCacheRepository;
    const { metricsService, metricMocks } = buildMetricsService();
    const bidlogAdd = jest
      .fn<Promise<void>, [string, BidLogJobData]>()
      .mockResolvedValue(undefined);
    const bidlogQueue = { add: bidlogAdd } as unknown as Queue<BidLogJobData>;
    const configService = {
      get: jest.fn((key: string, defaultValue?: string) =>
        key === 'RTB_BUDGET_MODE'
          ? (options.mode ?? defaultValue)
          : defaultValue
      ),
    } as unknown as ConfigService;

    const service = new RTBService(
      matcher,
      selector,
      cacheRepository,
      campaignCacheRepository,
      metricsService,
      bidlogQueue,
      configService
    );

    return {
      service,
      repositoryMocks,
      metricMocks,
      bidlogAdd,
      cacheSetAuctionData: cacheRepository.setAuctionData,
    };
  };

  it('reserves only the highest-ranked available candidate', async () => {
    const high = buildCandidate('high', 100);
    const low = buildCandidate('low', 10);
    const harness = buildHarness([low, high], { mode: 'winner_only' });

    const result = await harness.service.runAuction(context);

    expect(result.status).toBe('success');
    expect(result.data?.campaign.id).toBe(high.id);
    expect(result.data?.candidates).toEqual([high]);
    expect(harness.repositoryMocks.reserveAuction).toHaveBeenCalledTimes(1);
    const reservationRequest =
      harness.repositoryMocks.reserveAuction.mock.calls[0][0];
    expect(reservationRequest.blogId).toBe(context.blogId);
    expect(reservationRequest.budgetDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(typeof reservationRequest.expiresAt).toBe('number');
    expect(reservationRequest.candidates).toEqual([
      { campaignId: high.id, cpc: 10 },
      { campaignId: low.id, cpc: 10 },
    ]);
    expect(harness.cacheSetAuctionData).not.toHaveBeenCalled();
    expect(harness.repositoryMocks.incrementSpent).not.toHaveBeenCalled();
    expect(harness.repositoryMocks.decrementSpent).not.toHaveBeenCalled();
    expect(
      harness.metricMocks.observeRtbRollbackCandidateCount
    ).toHaveBeenCalledWith(0);
    expect(harness.bidlogAdd).toHaveBeenCalledWith(
      'save-bidlog',
      expect.objectContaining({
        items: [
          expect.objectContaining({ campaignId: high.id, status: 'WIN' }),
        ],
      })
    );
  });

  it('checks candidates in rank order and stops at the first reservable one', async () => {
    const high = buildCandidate('high', 100);
    const second = buildCandidate('second', 90);
    const third = buildCandidate('third', 80);
    const reserveAuction = jest
      .fn<Promise<ReserveAuctionResult>, [ReserveAuctionRequest]>()
      .mockImplementation((request) =>
        Promise.resolve({
          outcome: 'reserved',
          attemptedCount: 2,
          reservation: {
            version: 1,
            auctionId: request.auctionId,
            campaignId: second.id,
            blogId: request.blogId,
            cost: second.maxCpc,
            status: 'RESERVED',
            budgetDate: request.budgetDate,
            createdAt: 1,
            updatedAt: 1,
            expiresAt: request.expiresAt,
          },
        })
      );
    const harness = buildHarness([third, second, high], {
      mode: 'winner_only',
      reserveAuction,
    });

    const result = await harness.service.runAuction(context);

    expect(result.status).toBe('success');
    expect(result.data?.campaign.id).toBe(second.id);
    expect(reserveAuction).toHaveBeenCalledTimes(1);
    expect(
      harness.metricMocks.observeRtbReserveAttemptCandidateCount
    ).toHaveBeenCalledWith(2);
    expect(
      harness.metricMocks.observeRtbReservedCandidateCount
    ).toHaveBeenCalledWith(1);
    expect(harness.metricMocks.incRtbReservationFailure).toHaveBeenCalledWith(
      'rejected',
      1
    );
  });

  it('returns a business error without rollback when every candidate is exhausted', async () => {
    const candidates = [buildCandidate('high', 100), buildCandidate('low', 10)];
    const harness = buildHarness(candidates, {
      mode: 'winner_only',
      reserveAuction: jest
        .fn<Promise<ReserveAuctionResult>, [ReserveAuctionRequest]>()
        .mockResolvedValue({ outcome: 'exhausted', attemptedCount: 2 }),
    });

    const result = await harness.service.runAuction(context);

    expect(result.status).toBe('error');
    expect(harness.repositoryMocks.reserveAuction).toHaveBeenCalledTimes(1);
    expect(harness.repositoryMocks.decrementSpent).not.toHaveBeenCalled();
    expect(harness.bidlogAdd).not.toHaveBeenCalled();
    expect(
      harness.metricMocks.observeRtbReservedCandidateCount
    ).toHaveBeenCalledWith(0);
  });

  it('uses at most one Lua call per top-10 window', async () => {
    const candidates = Array.from({ length: 12 }, (_, index) =>
      buildCandidate(`candidate-${index + 1}`, 100 - index)
    );
    const reserveAuction = jest
      .fn<Promise<ReserveAuctionResult>, [ReserveAuctionRequest]>()
      .mockResolvedValueOnce({ outcome: 'exhausted', attemptedCount: 10 })
      .mockImplementationOnce((request) =>
        Promise.resolve({
          outcome: 'reserved',
          attemptedCount: 1,
          reservation: {
            version: 1,
            auctionId: request.auctionId,
            campaignId: candidates[10].id,
            blogId: request.blogId,
            cost: candidates[10].maxCpc,
            status: 'RESERVED',
            budgetDate: request.budgetDate,
            createdAt: 1,
            updatedAt: 1,
            expiresAt: request.expiresAt,
          },
        })
      );
    const harness = buildHarness(candidates, {
      mode: 'winner_only',
      reserveAuction,
    });

    const result = await harness.service.runAuction(context);

    expect(result.status).toBe('success');
    expect(result.data?.campaign.id).toBe(candidates[10].id);
    expect(reserveAuction).toHaveBeenCalledTimes(2);
    expect(reserveAuction).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        candidates: candidates.slice(0, 10).map((candidate) => ({
          campaignId: candidate.id,
          cpc: candidate.maxCpc,
        })),
      })
    );
    expect(reserveAuction).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        candidates: candidates.slice(10).map((candidate) => ({
          campaignId: candidate.id,
          cpc: candidate.maxCpc,
        })),
      })
    );
    expect(
      harness.metricMocks.observeRtbReserveWindowAttemptCount
    ).toHaveBeenCalledWith(2);
    expect(
      harness.metricMocks.observeRtbReserveAttemptCandidateCount
    ).toHaveBeenCalledWith(11);
  });

  it('does not overspend under concurrent winner-only requests', async () => {
    const dailyBudget = 100;
    const candidate = buildCandidate('limited', 100, {
      maxCpc: 10,
    });
    let spent = 0;
    const reserveAuction = jest
      .fn<Promise<ReserveAuctionResult>, [ReserveAuctionRequest]>()
      .mockImplementation((request) => {
        if (spent + candidate.maxCpc > dailyBudget) {
          return Promise.resolve({
            outcome: 'exhausted',
            attemptedCount: 1,
          });
        }
        spent += candidate.maxCpc;
        return Promise.resolve({
          outcome: 'reserved',
          attemptedCount: 1,
          reservation: {
            version: 1,
            auctionId: request.auctionId,
            campaignId: candidate.id,
            blogId: request.blogId,
            cost: candidate.maxCpc,
            status: 'RESERVED',
            budgetDate: request.budgetDate,
            createdAt: 1,
            updatedAt: 1,
            expiresAt: request.expiresAt,
          },
        });
      });
    const harness = buildHarness([candidate], {
      mode: 'winner_only',
      reserveAuction,
    });

    const results = await Promise.all(
      Array.from({ length: 50 }, () => harness.service.runAuction(context))
    );
    const successes = results.filter((result) => result.status === 'success');

    expect(successes).toHaveLength(10);
    expect(spent).toBe(100);
    expect(spent).toBeLessThanOrEqual(dailyBudget);
    expect(harness.bidlogAdd).toHaveBeenCalledTimes(10);
    expect(harness.repositoryMocks.decrementSpent).not.toHaveBeenCalled();
    expect(harness.cacheSetAuctionData).not.toHaveBeenCalled();
  });

  it('retains legacy top-k rollback behind the rollback flag', async () => {
    const high = buildCandidate('high', 100);
    const low = buildCandidate('low', 10);
    const harness = buildHarness([high, low], { mode: 'legacy_topk' });

    const result = await harness.service.runAuction(context);

    expect(result.status).toBe('success');
    expect(harness.repositoryMocks.incrementSpent).toHaveBeenCalledTimes(2);
    expect(harness.repositoryMocks.incrementSpent).toHaveBeenCalledWith(
      high.id,
      high.maxCpc
    );
    expect(harness.repositoryMocks.incrementSpent).toHaveBeenCalledWith(
      low.id,
      low.maxCpc
    );
    expect(harness.repositoryMocks.decrementSpent).toHaveBeenCalledWith(
      low.id,
      low.maxCpc
    );
    expect(harness.repositoryMocks.reserveAuction).not.toHaveBeenCalled();
    expect(harness.cacheSetAuctionData).toHaveBeenCalledTimes(1);
  });
});

function buildMetricsService(): {
  metricsService: MetricsService;
  metricMocks: MetricMocks;
} {
  const metricMocks: MetricMocks = {
    incRtbFallback: jest.fn(),
    observeRtbMatchedBeforeReserveCount: jest.fn(),
    observeRtbReserveWindowAttemptCount: jest.fn(),
    observeRtbReserveAttemptCandidateCount: jest.fn(),
    observeRtbReservedCandidateCount: jest.fn(),
    observeRtbRollbackCandidateCount: jest.fn(),
    recordDependency: jest.fn(),
    incRtbReservationFailure: jest.fn(),
    recordRtbStage: jest.fn(),
    observeRtbBidLogCount: jest.fn(),
    recordRtbRequest: jest.fn(),
  };
  return {
    metricMocks,
    metricsService: metricMocks as unknown as MetricsService,
  };
}
