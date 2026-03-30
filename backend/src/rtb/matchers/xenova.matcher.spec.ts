import { ConfigService } from '@nestjs/config';
import { MetricsService } from '../../metrics/metrics.service';
import { MLEngine } from '../ml/mlEngine.interface';
import { TransformerMatcher } from './xenova.matcher';
import { CampaignCacheRepository } from '../../campaign/repository/campaign.cache.repository.interface';
import type { CachedCampaign } from '../../campaign/types/campaign.types';

describe('TransformerMatcher ANN path', () => {
  const now = new Date('2026-03-29T00:00:00.000Z');

  const buildCampaign = (
    id: string,
    tags: string[],
    embeddingTags: Record<string, number[]>
  ): CachedCampaign => ({
    id,
    userId: 1,
    title: `campaign-${id}`,
    content: 'content',
    image: null,
    url: 'https://example.com',
    maxCpc: 100,
    dailyBudget: 1000,
    totalBudget: 10000,
    dailySpent: 0,
    totalSpent: 0,
    lastResetDate: now.toISOString(),
    isHighIntent: false,
    status: 'ACTIVE',
    startDate: new Date('2026-03-01T00:00:00.000Z').toISOString(),
    endDate: new Date('2026-04-01T00:00:00.000Z').toISOString(),
    createdAt: now.toISOString(),
    deletedAt: null,
    tags,
    embeddingTags,
  });

  const buildMetricsService = () =>
    ({
      incRtbFallback: jest.fn(),
      recordRtbStage: jest.fn(),
      observeRtbEligibleCampaignCount: jest.fn(),
      observeRtbAnnTagHitCount: jest.fn(),
      observeRtbAnnRetrievedCampaignCount: jest.fn(),
    }) as unknown as MetricsService;

  const buildConfigService = (overrides?: Record<string, string>) =>
    ({
      get: jest.fn((key: string, defaultValue?: string) => {
        if (overrides && key in overrides) {
          return overrides[key];
        }
        return defaultValue;
      }),
    }) as unknown as ConfigService;

  const buildMlEngine = () =>
    ({
      isReady: jest.fn(() => true),
      getEmbedding: jest.fn(async () => [1, 0]),
      calculateSimilarity: jest.fn(
        (vecA: number[], vecB: number[]) =>
          vecA.reduce((sum, value, index) => sum + value * vecB[index], 0)
      ),
      computeTextSimilarity: jest.fn(),
    }) as unknown as MLEngine;

  const buildRepository = (campaigns: CachedCampaign[]) =>
    ({
      saveCampaignCacheById: jest.fn(),
      updateCampaignWithoutCachedById: jest.fn(),
      findCampaignCacheById: jest.fn(),
      findCampaignCachesByIds: jest.fn(async (ids: string[]) =>
        campaigns.filter((campaign) => ids.includes(campaign.id))
      ),
      updateCampaignStatus: jest.fn(),
      updateDailySpentCacheById: jest.fn(),
      incrementSpent: jest.fn(),
      decrementSpent: jest.fn(),
      deleteCampaignEmbeddingById: jest.fn(),
      updateCampaignEmbeddingTags: jest.fn(),
      deleteCampaignCacheById: jest.fn(),
      existsCampaignCacheById: jest.fn(),
      getAllCampaigns: jest.fn(),
      resetDailySpentCache: jest.fn(),
      searchCampaignTagVectors: jest.fn(),
    }) as unknown as CampaignCacheRepository & {
      getAllCampaigns: jest.Mock;
      searchCampaignTagVectors: jest.Mock;
      findCampaignCachesByIds: jest.Mock;
    };

  beforeAll(() => {
    jest.useFakeTimers().setSystemTime(now);
  });

  afterAll(() => {
    jest.useRealTimers();
  });

  it('uses ANN retrieval and skips full campaign scan when enabled', async () => {
    const campaign1 = buildCampaign(
      'c1',
      ['typescript', 'nestjs'],
      {
        typescript: [1, 0],
        nestjs: [0.9, 0.1],
      }
    );
    const campaign2 = buildCampaign(
      'c2',
      ['react'],
      {
        react: [0.8, 0.2],
      }
    );

    const repository = buildRepository([campaign1, campaign2]);
    repository.searchCampaignTagVectors.mockResolvedValue([
      { campaignId: 'c1', tagName: 'typescript', distance: 0.02, similarity: 0.98 },
      { campaignId: 'c1', tagName: 'nestjs', distance: 0.06, similarity: 0.94 },
      { campaignId: 'c2', tagName: 'react', distance: 0.1, similarity: 0.9 },
    ]);

    const matcher = new TransformerMatcher(
      repository,
      buildMlEngine(),
      buildMetricsService(),
      buildConfigService({
        RTB_MATCHER_ANN_ENABLED: 'true',
        RTB_MATCHER_ANN_TOP_L: '10',
        RTB_MATCHER_ANN_TOP_M: '2',
        RTB_MATCHER_ANN_PER_CAMPAIGN_HIT_LIMIT: '2',
      })
    );

    const candidates = await matcher.findCandidatesByTags({
      blogKey: 'blog',
      blogId: 1,
      blogName: 'blog',
      tags: ['typescript', 'react', 'nestjs'],
      postUrl: 'https://example.com/post',
      behaviorScore: 80,
      isHighIntent: false,
    });

    expect(repository.searchCampaignTagVectors).toHaveBeenCalledTimes(1);
    expect(repository.findCampaignCachesByIds).toHaveBeenCalledWith(['c1', 'c2']);
    expect(repository.getAllCampaigns).not.toHaveBeenCalled();
    expect(candidates.map((candidate) => candidate.id)).toEqual(
      expect.arrayContaining(['c1', 'c2'])
    );
  });

  it('falls back when ANN returns no hits', async () => {
    const repository = buildRepository([]);
    repository.searchCampaignTagVectors.mockResolvedValue([]);
    const metrics = buildMetricsService();

    const matcher = new TransformerMatcher(
      repository,
      buildMlEngine(),
      metrics,
      buildConfigService({
        RTB_MATCHER_ANN_ENABLED: 'true',
      })
    );

    const candidates = await matcher.findCandidatesByTags({
      blogKey: 'blog',
      blogId: 1,
      blogName: 'blog',
      tags: ['typescript'],
      postUrl: 'https://example.com/post',
      behaviorScore: 20,
      isHighIntent: false,
    });

    expect(candidates).toEqual([]);
    expect((metrics.incRtbFallback as jest.Mock).mock.calls[0][0]).toBe(
      'matcher_empty'
    );
    expect(repository.getAllCampaigns).not.toHaveBeenCalled();
  });

  it('reuses request embedding cache for the same tag set regardless of order', async () => {
    const repository = buildRepository([]);
    repository.getAllCampaigns.mockResolvedValue([]);
    const mlEngine = buildMlEngine() as unknown as {
      getEmbedding: jest.Mock;
    };

    const matcher = new TransformerMatcher(
      repository,
      mlEngine as unknown as MLEngine,
      buildMetricsService(),
      buildConfigService()
    );

    await matcher.findCandidatesByTags({
      blogKey: 'blog',
      blogId: 1,
      blogName: 'blog',
      tags: ['TypeScript', 'React', 'Redis'],
      postUrl: 'https://example.com/post',
      behaviorScore: 20,
      isHighIntent: false,
    });

    await matcher.findCandidatesByTags({
      blogKey: 'blog',
      blogId: 1,
      blogName: 'blog',
      tags: ['Redis', 'TypeScript', 'React'],
      postUrl: 'https://example.com/post',
      behaviorScore: 20,
      isHighIntent: false,
    });

    expect(mlEngine.getEmbedding).toHaveBeenCalledTimes(1);
  });
});
