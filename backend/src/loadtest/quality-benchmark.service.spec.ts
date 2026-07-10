import { ConflictException, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { CampaignCacheRepository } from 'src/campaign/repository/campaign.cache.repository.interface';
import type { CachedCampaign } from 'src/campaign/types/campaign.types';
import { ContextEmbeddingService } from 'src/rtb/context/context-embedding.service';
import { Matcher } from 'src/rtb/matchers/matcher.interface';
import { MLEngine } from 'src/rtb/ml/mlEngine.interface';
import { QualityBenchmarkService } from './quality-benchmark.service';

function campaign(id: string): CachedCampaign {
  return {
    id,
    userId: 1,
    title: id,
    content: id,
    image: null,
    url: `https://example.com/${id}`,
    maxCpc: 100,
    dailyBudget: 10_000,
    totalBudget: 100_000,
    dailySpent: 0,
    totalSpent: 0,
    lastResetDate: '2026-07-10T00:00:00.000Z',
    isHighIntent: false,
    status: 'ACTIVE',
    startDate: '2026-07-09T00:00:00.000Z',
    endDate: '2027-07-10T00:00:00.000Z',
    createdAt: '2026-07-10T00:00:00.000Z',
    deletedAt: null,
    tags: ['react'],
    embeddingTags: { react: [1, 0] },
  };
}

describe('QualityBenchmarkService', () => {
  let service: QualityBenchmarkService;
  let state: CachedCampaign[];
  let repository: {
    getAllCampaigns: jest.Mock;
    deleteCampaignCacheById: jest.Mock;
    saveCampaignCacheById: jest.Mock;
    findCampaignCachesByIds: jest.Mock;
    searchCampaignTagVectors: jest.Mock;
    searchCampaignDocumentVectors: jest.Mock;
    reserveFirstAvailable: jest.Mock;
  };
  let matcher: { findCandidatesByTags: jest.Mock };
  let contextEmbeddingService: {
    completeJob: jest.Mock;
    clearReadyL1: jest.Mock;
  };

  beforeEach(() => {
    state = [campaign('existing-campaign')];
    repository = {
      getAllCampaigns: jest.fn(async () => [...state]),
      deleteCampaignCacheById: jest.fn(async (id: string) => {
        state = state.filter((item) => item.id !== id);
      }),
      saveCampaignCacheById: jest.fn(
        async (_id: string, item: CachedCampaign) => {
          state = [
            ...state.filter((existing) => existing.id !== item.id),
            item,
          ];
        }
      ),
      findCampaignCachesByIds: jest.fn(async (ids: string[]) =>
        state.filter((item) => ids.includes(item.id))
      ),
      searchCampaignTagVectors: jest.fn(async () =>
        state.flatMap((item) =>
          (item.tags ?? []).map((tagName) => ({
            campaignId: item.id,
            tagName,
            distance: 0,
            similarity: 1,
          }))
        )
      ),
      searchCampaignDocumentVectors: jest.fn(() =>
        Promise.resolve(
          state.map((item) => ({
            campaignId: item.id,
            distance: 0,
            similarity: 1,
          }))
        )
      ),
      reserveFirstAvailable: jest.fn(),
    };
    matcher = {
      findCandidatesByTags: jest.fn(async () =>
        state.map((item) => ({
          ...item,
          similarity: 0.8,
          score: 86,
        }))
      ),
    };
    contextEmbeddingService = {
      completeJob: jest.fn().mockResolvedValue(undefined),
      clearReadyL1: jest.fn(),
    };
    const configService = {
      get: jest.fn((key: string) => {
        const values: Record<string, string> = {
          LOADTEST_RESET_ENABLED: 'true',
          LOADTEST_RESET_TOKEN: 'secret',
          RTB_MATCHER_ANN_ENABLED: 'true',
          RTB_CONTEXT_DECISION_ENABLED: 'true',
          RTB_CAMPAIGN_SOURCE: 'local_snapshot',
        };
        return values[key];
      }),
    };
    const mlEngine = {
      isReady: jest.fn(() => true),
      getProfileName: jest.fn(() => 'legacy_minilm'),
      getModelId: jest.fn(() => 'test/model'),
      getModelVersion: jest.fn(() => 'quality-model-v1'),
      getEmbeddingDimension: jest.fn(() => 2),
      getEmbedding: jest.fn(async () => [1, 0]),
    };

    service = new QualityBenchmarkService(
      configService as unknown as ConfigService,
      repository as unknown as CampaignCacheRepository,
      mlEngine as unknown as MLEngine,
      contextEmbeddingService as unknown as ContextEmbeddingService,
      matcher as unknown as Matcher
    );
  });

  async function loadQualitySession(): Promise<string> {
    const result = await service.loadCampaigns(
      {
        datasetVersion: 'rtb-phase4-quality-v1',
        campaigns: [
          {
            campaignKey: 'q4-frontend-guide',
            title: 'Frontend guide',
            content: 'React performance guide',
            tags: ['React'],
          },
        ],
      },
      'secret'
    );
    return result.sessionId;
  }

  it('temporarily replaces serving campaigns and restores the previous cache', async () => {
    const loaded = await service.loadCampaigns(
      {
        datasetVersion: 'rtb-phase4-quality-v1',
        campaigns: [
          {
            campaignKey: 'q4-frontend-guide',
            title: 'Frontend guide',
            content: 'React performance guide',
            tags: ['React'],
          },
        ],
      },
      'secret'
    );
    const sessionId = loaded.sessionId;

    expect(state.map((item) => item.id)).toEqual(['q4-frontend-guide']);
    expect(state[0].embeddingTags?.react).toEqual([1, 0]);
    expect(state[0].embeddingDocument).toEqual([1, 0]);
    expect(state[0].embeddingModelVersion).toBe('quality-model-v1');
    expect(loaded.runtime).toMatchObject({
      embeddingProfile: 'legacy_minilm',
      modelId: 'test/model',
      modelVersion: 'quality-model-v1',
      embeddingDimension: 2,
    });

    const restored = await service.restoreCampaigns(sessionId, 'secret');

    expect(restored).toMatchObject({
      restoredCampaignCount: 1,
      removedQualityCampaignCount: 1,
    });
    expect(state.map((item) => item.id)).toEqual(['existing-campaign']);
    expect(contextEmbeddingService.clearReadyL1).toHaveBeenCalledTimes(1);
  });

  it('extracts deterministic rankings without calling reserve or mutating budget', async () => {
    const sessionId = await loadQualitySession();
    const result = await service.extractRankings(
      {
        sessionId,
        datasetVersion: 'rtb-phase4-quality-v1',
        retrievalMode: 'dense_only',
        topK: 10,
        contents: [
          {
            contentId: 'q4-content-001',
            title: 'React rendering',
            body: 'Reduce unnecessary rendering work.',
            tags: ['React'],
          },
        ],
      },
      'secret'
    );

    expect(result).toMatchObject({
      reserveCalled: false,
      budgetMutationCount: 0,
      rankings: [
        {
          contentId: 'q4-content-001',
          candidates: [{ campaignKey: 'q4-frontend-guide' }],
        },
      ],
    });
    expect(repository.reserveFirstAvailable).not.toHaveBeenCalled();
    expect(contextEmbeddingService.completeJob).toHaveBeenCalledTimes(1);
    expect(state[0]).toMatchObject({ dailySpent: 0, totalSpent: 0 });
  });

  it('fails extraction when matcher-side behavior mutates campaign budget', async () => {
    const sessionId = await loadQualitySession();
    matcher.findCandidatesByTags.mockImplementationOnce(async () => {
      state[0] = { ...state[0], dailySpent: 100, totalSpent: 100 };
      return [{ ...state[0], similarity: 0.8, score: 86 }];
    });

    await expect(
      service.extractRankings(
        {
          sessionId,
          datasetVersion: 'rtb-phase4-quality-v1',
          contents: [
            {
              contentId: 'q4-content-001',
              title: 'React rendering',
              body: 'Body',
              tags: ['React'],
            },
          ],
        },
        'secret'
      )
    ).rejects.toThrow('reserve-free 계약이 깨졌습니다');
  });

  it('rejects access without the loadtest token', async () => {
    await expect(
      service.loadCampaigns(
        {
          datasetVersion: 'rtb-phase4-quality-v1',
          campaigns: [
            {
              campaignKey: 'q4-frontend-guide',
              title: 'Frontend guide',
              content: 'React performance guide',
              tags: ['React'],
            },
          ],
        },
        'wrong'
      )
    ).rejects.toThrow(UnauthorizedException);
  });

  it('rejects foreign candidates instead of hiding isolation failures', async () => {
    const sessionId = await loadQualitySession();
    matcher.findCandidatesByTags.mockResolvedValueOnce([
      { ...campaign('foreign'), similarity: 0.9, score: 90 },
    ]);

    await expect(
      service.extractRankings(
        {
          sessionId,
          datasetVersion: 'rtb-phase4-quality-v1',
          contents: [
            {
              contentId: 'q4-content-001',
              title: 'React rendering',
              body: 'Body',
              tags: ['React'],
            },
          ],
        },
        'secret'
      )
    ).rejects.toThrow(ConflictException);
  });
});
