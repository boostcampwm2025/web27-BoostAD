import { ConfigService } from '@nestjs/config';
import { CacheRepository } from 'src/cache/repository/cache.repository.interface';
import { CampaignCacheRepository } from 'src/campaign/repository/campaign.cache.repository.interface';
import type {
  BudgetReservationCandidate,
  BudgetReservationResult,
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

type ReserveFirstAvailableMock = jest.Mock<
  Promise<BudgetReservationResult | null>,
  [BudgetReservationCandidate[]]
>;

type IncrementSpentMock = jest.Mock<Promise<boolean>, [string, number]>;

type RepositoryMocks = {
  incrementSpent: IncrementSpentMock;
  reserveFirstAvailable: ReserveFirstAvailableMock;
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
      reserveFirstAvailable?: ReserveFirstAvailableMock;
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
      reserveFirstAvailable:
        options.reserveFirstAvailable ??
        jest
          .fn<
            Promise<BudgetReservationResult | null>,
            [BudgetReservationCandidate[]]
          >()
          .mockImplementation((window) =>
            Promise.resolve({
              campaignId: window[0].campaignId,
              attemptedCount: 1,
            })
          ),
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
      get: jest.fn(
        (_key: string, defaultValue: string) => options.mode ?? defaultValue
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
    expect(harness.repositoryMocks.reserveFirstAvailable).toHaveBeenCalledTimes(
      1
    );
    expect(harness.repositoryMocks.reserveFirstAvailable).toHaveBeenCalledWith([
      { campaignId: high.id, cpc: 10 },
      { campaignId: low.id, cpc: 10 },
    ]);
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
    const reserveFirstAvailable = jest
      .fn<
        Promise<BudgetReservationResult | null>,
        [BudgetReservationCandidate[]]
      >()
      .mockResolvedValue({
        campaignId: second.id,
        attemptedCount: 2,
      });
    const harness = buildHarness([third, second, high], {
      mode: 'winner_only',
      reserveFirstAvailable,
    });

    const result = await harness.service.runAuction(context);

    expect(result.status).toBe('success');
    expect(result.data?.campaign.id).toBe(second.id);
    expect(reserveFirstAvailable).toHaveBeenCalledTimes(1);
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
      reserveFirstAvailable: jest
        .fn<
          Promise<BudgetReservationResult | null>,
          [BudgetReservationCandidate[]]
        >()
        .mockResolvedValue(null),
    });

    const result = await harness.service.runAuction(context);

    expect(result.status).toBe('error');
    expect(harness.repositoryMocks.reserveFirstAvailable).toHaveBeenCalledTimes(
      1
    );
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
    const reserveFirstAvailable = jest
      .fn<
        Promise<BudgetReservationResult | null>,
        [BudgetReservationCandidate[]]
      >()
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({
        campaignId: candidates[10].id,
        attemptedCount: 1,
      });
    const harness = buildHarness(candidates, {
      mode: 'winner_only',
      reserveFirstAvailable,
    });

    const result = await harness.service.runAuction(context);

    expect(result.status).toBe('success');
    expect(result.data?.campaign.id).toBe(candidates[10].id);
    expect(reserveFirstAvailable).toHaveBeenCalledTimes(2);
    expect(reserveFirstAvailable).toHaveBeenNthCalledWith(
      1,
      candidates.slice(0, 10).map((candidate) => ({
        campaignId: candidate.id,
        cpc: candidate.maxCpc,
      }))
    );
    expect(reserveFirstAvailable).toHaveBeenNthCalledWith(
      2,
      candidates.slice(10).map((candidate) => ({
        campaignId: candidate.id,
        cpc: candidate.maxCpc,
      }))
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
    const reserveFirstAvailable = jest
      .fn<
        Promise<BudgetReservationResult | null>,
        [BudgetReservationCandidate[]]
      >()
      .mockImplementation(() => {
        if (spent + candidate.maxCpc > dailyBudget) {
          return Promise.resolve(null);
        }
        spent += candidate.maxCpc;
        return Promise.resolve({
          campaignId: candidate.id,
          attemptedCount: 1,
        });
      });
    const harness = buildHarness([candidate], {
      mode: 'winner_only',
      reserveFirstAvailable,
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
