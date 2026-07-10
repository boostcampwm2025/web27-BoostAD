import { ConfigService } from '@nestjs/config';
import { MetricsService } from '../../metrics/metrics.service';
import { MLEngine } from '../ml/mlEngine.interface';
import { RequestEmbeddingCacheService } from '../ml/request-embedding-cache.service';
import { TransformerMatcher } from './xenova.matcher';
import { CampaignCacheRepository } from '../../campaign/repository/campaign.cache.repository.interface';
import type { CachedCampaign } from '../../campaign/types/campaign.types';
import { CampaignServingSnapshotService } from '../../campaign/campaign-serving-snapshot.service';
import { ContextEmbeddingService } from '../context/context-embedding.service';

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
      incRtbEmbeddingL1Hit: jest.fn(),
      incRtbEmbeddingL1Miss: jest.fn(),
      incRtbEmbeddingL1Eviction: jest.fn(),
      incRtbEmbeddingL2Hit: jest.fn(),
      incRtbEmbeddingL2Miss: jest.fn(),
      incRtbEmbeddingL2Timeout: jest.fn(),
      incRtbEmbeddingL2WriteTimeout: jest.fn(),
      incRtbEmbeddingL2Error: jest.fn(),
      incRtbEmbeddingSingleflightWait: jest.fn(),
      incRtbEmbeddingRuntime: jest.fn(),
      incRtbEmbeddingSource: jest.fn(),
      recordRtbEmbeddingBackground: jest.fn(),
      recordRtbLexicalFallback: jest.fn(),
      recordRtbContextDecision: jest.fn(),
      observeRtbHybridSparseLookupDuration: jest.fn(),
      observeRtbHybridFusionDuration: jest.fn(),
    }) as unknown as MetricsService;

  const buildConfigService = (overrides?: Record<string, string>) =>
    ({
      get: jest.fn((key: string, defaultValue?: string) => {
        if (overrides && key in overrides) {
          return overrides[key];
        }
        if (key === 'RTB_DENSE_RETRIEVAL_MODE') {
          return 'legacy_tag';
        }
        return defaultValue;
      }),
    }) as unknown as ConfigService;

  const buildProductDefaultConfigService = (
    overrides?: Record<string, string>
  ) =>
    ({
      get: jest.fn((key: string, defaultValue?: string) =>
        overrides && key in overrides ? overrides[key] : defaultValue
      ),
    }) as unknown as ConfigService;

  const buildMlEngine = () =>
    ({
      isReady: jest.fn(() => true),
      getModelVersion: jest.fn(() => 'Xenova/all-MiniLM-L6-v2'),
      getEmbeddingDimension: jest.fn(() => 2),
      getEmbedding: jest.fn().mockResolvedValue([1, 0]),
      calculateSimilarity: jest.fn(
        (vecA: ArrayLike<number>, vecB: ArrayLike<number>) => {
          let similarity = 0;
          for (let index = 0; index < vecA.length; index++) {
            similarity += vecA[index] * vecB[index];
          }
          return similarity;
        }
      ),
      computeTextSimilarity: jest.fn(),
    }) as unknown as MLEngine;

  const buildEmbeddingCache = (
    mlEngine: MLEngine,
    metrics: MetricsService,
    config: ConfigService
  ) =>
    new RequestEmbeddingCacheService(mlEngine, metrics, config, {
      get: jest.fn().mockResolvedValue(null),
      set: jest.fn().mockResolvedValue('OK'),
    } as never);

  const buildMatcher = (
    repository: CampaignCacheRepository,
    snapshot: CampaignServingSnapshotService,
    mlEngine: MLEngine,
    metrics: MetricsService,
    config: ConfigService,
    contextEmbeddingService = {
      resolveForDecision: jest.fn().mockResolvedValue({ status: 'MISS' }),
    } as unknown as ContextEmbeddingService
  ) =>
    new TransformerMatcher(
      repository,
      snapshot,
      mlEngine,
      buildEmbeddingCache(mlEngine, metrics, config),
      contextEmbeddingService,
      metrics,
      config
    );

  const buildRepository = (campaigns: CachedCampaign[]) =>
    ({
      saveCampaignCacheById: jest.fn(),
      updateCampaignWithoutCachedById: jest.fn(),
      findCampaignCacheById: jest.fn(),
      findCampaignCachesByIds: jest.fn((ids: string[]) =>
        Promise.resolve(
          campaigns.filter((campaign) => ids.includes(campaign.id))
        )
      ),
      updateCampaignStatus: jest.fn(),
      updateDailySpentCacheById: jest.fn(),
      incrementSpent: jest.fn(),
      decrementSpent: jest.fn(),
      deleteCampaignEmbeddingById: jest.fn(),
      updateCampaignEmbeddingTags: jest.fn(),
      updateCampaignEmbeddings: jest.fn(),
      deleteCampaignCacheById: jest.fn(),
      existsCampaignCacheById: jest.fn(),
      getAllCampaigns: jest.fn(),
      resetDailySpentCache: jest.fn(),
      searchCampaignTagVectors: jest.fn(),
      searchCampaignDocumentVectors: jest.fn(),
    }) as unknown as CampaignCacheRepository & {
      getAllCampaigns: jest.Mock;
      searchCampaignTagVectors: jest.Mock;
      searchCampaignDocumentVectors: jest.Mock;
      findCampaignCachesByIds: jest.Mock;
    };

  const buildSnapshot = (campaigns: CachedCampaign[]) =>
    ({
      findCampaignsByIds: jest.fn((ids: string[]) =>
        Promise.resolve(
          ids.flatMap((id) => {
            const campaign = campaigns.find((item) => item.id === id);
            return campaign ? [campaign] : [];
          })
        )
      ),
      findCampaignsByTags: jest.fn((tags: string[]) =>
        Promise.resolve(
          campaigns.filter((campaign) =>
            campaign.tags?.some((tag) => tags.includes(tag.toLowerCase()))
          )
        )
      ),
    }) as unknown as CampaignServingSnapshotService & {
      findCampaignsByIds: jest.Mock;
      findCampaignsByTags: jest.Mock;
    };

  beforeAll(() => {
    jest.useFakeTimers().setSystemTime(now);
  });

  afterAll(() => {
    jest.useRealTimers();
  });

  it('uses ANN retrieval and skips full campaign scan when enabled', async () => {
    const campaign1 = buildCampaign('c1', ['typescript', 'nestjs'], {
      typescript: [1, 0],
      nestjs: [0.9, 0.1],
    });
    const campaign2 = buildCampaign('c2', ['react'], {
      react: [0.8, 0.2],
    });

    const repository = buildRepository([campaign1, campaign2]);
    repository.searchCampaignTagVectors.mockResolvedValue([
      {
        campaignId: 'c1',
        tagName: 'typescript',
        distance: 0.02,
        similarity: 0.98,
      },
      { campaignId: 'c1', tagName: 'nestjs', distance: 0.06, similarity: 0.94 },
      { campaignId: 'c2', tagName: 'react', distance: 0.1, similarity: 0.9 },
    ]);

    const matcher = buildMatcher(
      repository,
      buildSnapshot([campaign1, campaign2]),
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
    expect(repository.findCampaignCachesByIds).toHaveBeenCalledWith([
      'c1',
      'c2',
    ]);
    expect(repository.getAllCampaigns).not.toHaveBeenCalled();
    expect(candidates.map((candidate) => candidate.id)).toEqual(
      expect.arrayContaining(['c1', 'c2'])
    );
  });

  it('falls back when ANN returns no hits', async () => {
    const repository = buildRepository([]);
    repository.searchCampaignTagVectors.mockResolvedValue([]);
    const metrics = buildMetricsService();

    const matcher = buildMatcher(
      repository,
      buildSnapshot([]),
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
    const metricsMock = metrics as unknown as {
      incRtbFallback: jest.Mock;
    };
    expect(metricsMock.incRtbFallback).toHaveBeenCalledWith('matcher_empty');
    expect(repository.getAllCampaigns).not.toHaveBeenCalled();
  });

  it('uses campaign document ANN by default without tag-vector rerank', async () => {
    const campaign1 = {
      ...buildCampaign('c1', ['typescript'], { typescript: [1, 0] }),
      embeddingDocument: [0.4, 0.6],
    };
    const campaign2 = {
      ...buildCampaign('c2', ['react'], { react: [0.8, 0.2] }),
      embeddingDocument: [0.9, 0.1],
    };
    const repository = buildRepository([campaign1, campaign2]);
    repository.searchCampaignDocumentVectors.mockResolvedValue([
      { campaignId: 'c2', distance: 0.1, similarity: 0.9 },
      { campaignId: 'c1', distance: 0.6, similarity: 0.4 },
      { campaignId: 'below-threshold', distance: 0.8, similarity: 0.2 },
    ]);

    const matcher = buildMatcher(
      repository,
      buildSnapshot([campaign1, campaign2]),
      buildMlEngine(),
      buildMetricsService(),
      buildProductDefaultConfigService({
        RTB_MATCHER_ANN_ENABLED: 'true',
        RTB_CAMPAIGN_SOURCE: 'local_snapshot',
        RTB_MATCHER_DOCUMENT_SIMILARITY_THRESHOLD: '0.3',
        RTB_MATCHER_ANN_TOP_M: '10',
      })
    );

    const candidates = await matcher.findCandidatesByTags({
      blogKey: 'blog',
      blogId: 1,
      blogName: 'blog',
      tags: ['typescript'],
      postUrl: 'https://example.com/post',
      behaviorScore: 50,
      isHighIntent: false,
    });

    expect(repository.searchCampaignDocumentVectors).toHaveBeenCalledTimes(1);
    expect(repository.searchCampaignTagVectors).not.toHaveBeenCalled();
    expect(candidates.map((candidate) => candidate.id)).toEqual(['c2', 'c1']);
    expect(candidates.map((candidate) => candidate.similarity)).toEqual([
      0.9, 0.4,
    ]);
  });

  it('returns the real hybrid reserve candidates when RTB_RETRIEVAL_MODE=hybrid', async () => {
    const denseOnly = {
      ...buildCampaign('dense-1', ['typescript'], { typescript: [1, 0] }),
      embeddingDocument: [0.9, 0.1],
    };
    const sparseOnly = {
      ...buildCampaign('sparse-1', ['typescript'], { typescript: [0.5, 0.5] }),
      embeddingDocument: [0.8, 0.2],
      maxCpc: 200,
    };
    const repository = buildRepository([denseOnly, sparseOnly]);
    repository.searchCampaignDocumentVectors.mockResolvedValue([
      { campaignId: 'dense-1', distance: 0.1, similarity: 0.9 },
    ]);
    const matcher = buildMatcher(
      repository,
      buildSnapshot([denseOnly, sparseOnly]),
      buildMlEngine(),
      buildMetricsService(),
      buildProductDefaultConfigService({
        RTB_MATCHER_ANN_ENABLED: 'true',
        RTB_CAMPAIGN_SOURCE: 'local_snapshot',
        RTB_MATCHER_DOCUMENT_SIMILARITY_THRESHOLD: '0.3',
        RTB_RETRIEVAL_MODE: 'hybrid',
        RTB_HYBRID_SPARSE_WEIGHT: '0.2',
        RTB_HYBRID_SPARSE_SUPPLEMENT_LIMIT: '10',
        RTB_HYBRID_FINAL_LIMIT: '10',
      })
    );

    const candidates = await matcher.findCandidatesByTags({
      blogKey: 'blog',
      blogId: 1,
      blogName: 'blog',
      tags: ['typescript'],
      postUrl: 'https://example.com/post',
      behaviorScore: 50,
      isHighIntent: false,
    });

    expect(candidates.map((candidate) => candidate.id)).toEqual([
      'dense-1',
      'sparse-1',
    ]);
    expect(repository.reserveFirstAvailable).not.toBeDefined();
  });

  it('returns Hybrid rankings from findQualityRankings(hybrid)', async () => {
    const denseOnly = {
      ...buildCampaign('dense-1', ['react'], { react: [1, 0] }),
      embeddingDocument: [0.9, 0.1],
    };
    const sparseOnly = {
      ...buildCampaign('sparse-1', ['typescript'], {
        typescript: [0.5, 0.5],
      }),
      embeddingDocument: [0.8, 0.2],
      maxCpc: 200,
    };
    const repository = buildRepository([denseOnly, sparseOnly]);
    repository.searchCampaignDocumentVectors.mockResolvedValue([
      { campaignId: 'dense-1', distance: 0.1, similarity: 0.9 },
    ]);
    const matcher = buildMatcher(
      repository,
      buildSnapshot([denseOnly, sparseOnly]),
      buildMlEngine(),
      buildMetricsService(),
      buildProductDefaultConfigService({
        RTB_MATCHER_ANN_ENABLED: 'true',
        RTB_CAMPAIGN_SOURCE: 'local_snapshot',
        RTB_MATCHER_DOCUMENT_SIMILARITY_THRESHOLD: '0.3',
        RTB_RETRIEVAL_MODE: 'dense_only',
        RTB_HYBRID_SPARSE_WEIGHT: '0.2',
        RTB_HYBRID_SPARSE_SUPPLEMENT_LIMIT: '10',
        RTB_HYBRID_FINAL_LIMIT: '10',
      })
    );

    const hybrid = await matcher.findQualityRankings(
      {
        blogKey: 'blog',
        blogId: 1,
        blogName: 'blog',
        tags: ['typescript'],
        postUrl: 'https://example.com/post',
        behaviorScore: 50,
        isHighIntent: false,
      },
      'hybrid'
    );

    expect(hybrid.map((candidate) => candidate.id)).toEqual(
      expect.arrayContaining(['dense-1', 'sparse-1'])
    );
    expect(hybrid[0]?.id).toBe('dense-1');
  });

  it('exact-reranks the hybrid pool below the locked dense winner', async () => {
    const denseFirstByAnn = {
      ...buildCampaign('dense-ann-1', ['react'], { react: [1, 0] }),
      embeddingDocument: [0.6, 0.4],
      maxCpc: 100,
    };
    const denseBestByExact = {
      ...buildCampaign('dense-exact-1', ['node'], { node: [1, 0] }),
      embeddingDocument: [0.9, 0.1],
      maxCpc: 100,
    };
    const sparseOnly = {
      ...buildCampaign('sparse-1', ['typescript'], { typescript: [1, 0] }),
      embeddingDocument: [1, 0],
      maxCpc: 500,
    };
    const campaigns = [denseFirstByAnn, denseBestByExact, sparseOnly];
    const repository = buildRepository(campaigns);
    repository.searchCampaignDocumentVectors.mockResolvedValue([
      { campaignId: 'dense-ann-1', distance: 0.01, similarity: 0.99 },
      { campaignId: 'dense-exact-1', distance: 0.02, similarity: 0.98 },
    ]);
    const matcher = buildMatcher(
      repository,
      buildSnapshot(campaigns),
      buildMlEngine(),
      buildMetricsService(),
      buildProductDefaultConfigService({
        RTB_MATCHER_ANN_ENABLED: 'true',
        RTB_CAMPAIGN_SOURCE: 'local_snapshot',
        RTB_MATCHER_DOCUMENT_SIMILARITY_THRESHOLD: '0.3',
        RTB_HYBRID_SPARSE_WEIGHT: '0.2',
        RTB_HYBRID_SPARSE_SUPPLEMENT_LIMIT: '10',
        RTB_HYBRID_FINAL_LIMIT: '10',
      })
    );

    const hybrid = await matcher.findQualityRankings(
      {
        blogKey: 'blog',
        blogId: 1,
        blogName: 'blog',
        tags: ['typescript'],
        postUrl: 'https://example.com/post',
        behaviorScore: 50,
        isHighIntent: false,
      },
      'hybrid'
    );

    expect(hybrid.map((candidate) => candidate.id)).toEqual([
      'dense-ann-1',
      'dense-exact-1',
      'sparse-1',
    ]);
    expect(hybrid[0].similarity).toBe(0.6);
    expect(hybrid[1].similarity).toBe(0.9);
    expect(hybrid[2].score).toBeLessThan(hybrid[1].score);
  });

  it('does not run Hybrid retrieval when RTB_RETRIEVAL_MODE=dense_only', async () => {
    const campaign1 = {
      ...buildCampaign('c1', ['typescript'], { typescript: [1, 0] }),
      embeddingDocument: [0.4, 0.6],
    };
    const repository = buildRepository([campaign1]);
    repository.searchCampaignDocumentVectors.mockResolvedValue([
      { campaignId: 'c1', distance: 0.1, similarity: 0.9 },
    ]);
    const snapshot = buildSnapshot([campaign1]);
    const matcher = buildMatcher(
      repository,
      snapshot,
      buildMlEngine(),
      buildMetricsService(),
      buildProductDefaultConfigService({
        RTB_MATCHER_ANN_ENABLED: 'true',
        RTB_CAMPAIGN_SOURCE: 'local_snapshot',
        RTB_RETRIEVAL_MODE: 'dense_only',
      })
    );

    const candidates = await matcher.findCandidatesByTags({
      blogKey: 'blog',
      blogId: 1,
      blogName: 'blog',
      tags: ['typescript'],
      postUrl: 'https://example.com/post',
      behaviorScore: 50,
      isHighIntent: false,
    });

    expect(candidates.map((candidate) => candidate.id)).toEqual(['c1']);
    expect(snapshot.findCampaignsByTags).not.toHaveBeenCalled();
  });

  it('returns no semantic candidates when every document is below threshold', async () => {
    const campaign = buildCampaign('c1', ['typescript'], {
      typescript: [1, 0],
    });
    const repository = buildRepository([campaign]);
    repository.searchCampaignDocumentVectors.mockResolvedValue([
      { campaignId: 'c1', distance: 0.75, similarity: 0.25 },
    ]);
    const metrics = buildMetricsService();
    const matcher = buildMatcher(
      repository,
      buildSnapshot([campaign]),
      buildMlEngine(),
      metrics,
      buildConfigService({
        RTB_MATCHER_ANN_ENABLED: 'true',
        RTB_DENSE_RETRIEVAL_MODE: 'semantic_document',
        RTB_MATCHER_DOCUMENT_SIMILARITY_THRESHOLD: '0.3',
      })
    );

    await expect(
      matcher.findCandidatesByTags({
        blogKey: 'blog',
        blogId: 1,
        blogName: 'blog',
        tags: ['typescript'],
        postUrl: 'https://example.com/post',
        behaviorScore: 50,
        isHighIntent: false,
      })
    ).resolves.toEqual([]);
    expect(repository.findCampaignCachesByIds).not.toHaveBeenCalled();
    expect(
      (metrics as unknown as { incRtbFallback: jest.Mock }).incRtbFallback
    ).toHaveBeenCalledWith('matcher_empty');
  });

  it('uses bounded lexical fallback while the semantic index is empty', async () => {
    const campaign = buildCampaign('c1', ['typescript'], {
      typescript: [1, 0],
    });
    const repository = buildRepository([campaign]);
    repository.searchCampaignDocumentVectors.mockResolvedValue([]);
    const metrics = buildMetricsService();
    const matcher = buildMatcher(
      repository,
      buildSnapshot([campaign]),
      buildMlEngine(),
      metrics,
      buildConfigService({
        RTB_MATCHER_ANN_ENABLED: 'true',
        RTB_CAMPAIGN_SOURCE: 'local_snapshot',
        RTB_DENSE_RETRIEVAL_MODE: 'semantic_document',
      })
    );

    const candidates = await matcher.findCandidatesByTags({
      blogKey: 'blog',
      blogId: 1,
      blogName: 'blog',
      tags: ['typescript'],
      postUrl: 'https://example.com/post',
      behaviorScore: 50,
      isHighIntent: false,
    });

    expect(candidates.map((candidate) => candidate.id)).toEqual(['c1']);
    expect(
      (metrics as unknown as { recordRtbLexicalFallback: jest.Mock })
        .recordRtbLexicalFallback
    ).toHaveBeenCalledWith('semantic_index_unready', 1);
  });

  it('reuses request embedding cache for the same tag set regardless of order', async () => {
    const repository = buildRepository([]);
    repository.getAllCampaigns.mockResolvedValue([]);
    const mlEngine = buildMlEngine() as unknown as {
      getEmbedding: jest.Mock;
    };
    const metrics = buildMetricsService();
    const config = buildConfigService();

    const matcher = buildMatcher(
      repository,
      buildSnapshot([]),
      mlEngine as unknown as MLEngine,
      metrics,
      config
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

  it('U13: canonicalizes case, duplicate tags, whitespace, and Unicode form', async () => {
    const repository = buildRepository([]);
    repository.getAllCampaigns.mockResolvedValue([]);
    const mlEngine = buildMlEngine() as unknown as {
      getEmbedding: jest.Mock;
    };
    const metrics = buildMetricsService();
    const config = buildConfigService();
    const matcher = buildMatcher(
      repository,
      buildSnapshot([]),
      mlEngine as unknown as MLEngine,
      metrics,
      config
    );

    await matcher.findCandidatesByTags({
      blogKey: 'blog',
      blogId: 1,
      blogName: 'blog',
      tags: [' React ', 'REACT', 'Cafe\u0301'],
      postUrl: 'https://example.com/post',
      behaviorScore: 20,
      isHighIntent: false,
    });
    await matcher.findCandidatesByTags({
      blogKey: 'blog',
      blogId: 1,
      blogName: 'blog',
      tags: ['café', 'react'],
      postUrl: 'https://example.com/post',
      behaviorScore: 20,
      isHighIntent: false,
    });

    expect(mlEngine.getEmbedding).toHaveBeenCalledTimes(1);
    expect(mlEngine.getEmbedding).toHaveBeenCalledWith('café react', 'query');
  });

  it('3B-M1: cold embedding miss returns ranked lexical candidates immediately', async () => {
    const exact = {
      ...buildCampaign('c1', ['react', 'typescript'], {}),
      maxCpc: 100,
    };
    const partial = {
      ...buildCampaign('c2', ['react'], {}),
      maxCpc: 500,
    };
    const unrelated = buildCampaign('c3', ['redis'], {});
    const campaigns = [exact, partial, unrelated];
    const repository = buildRepository(campaigns);
    const snapshot = buildSnapshot(campaigns);
    const mlEngine = buildMlEngine() as unknown as {
      getEmbedding: jest.Mock;
    };
    const metrics = buildMetricsService();
    const matcher = buildMatcher(
      repository,
      snapshot,
      mlEngine as unknown as MLEngine,
      metrics,
      buildConfigService({
        RTB_MATCHER_ANN_ENABLED: 'true',
        RTB_CAMPAIGN_SOURCE: 'local_snapshot',
        RTB_EMBEDDING_COLD_MISS_FAST_PATH_ENABLED: 'true',
      })
    );

    const candidates = await matcher.findCandidatesByTags({
      blogKey: 'blog',
      blogId: 1,
      blogName: 'blog',
      tags: ['TypeScript', 'React'],
      postUrl: 'https://example.com/post',
      behaviorScore: 20,
      isHighIntent: false,
    });

    expect(candidates.map((candidate) => candidate.id)).toEqual(['c1', 'c2']);
    expect(repository.searchCampaignTagVectors).not.toHaveBeenCalled();
    expect(snapshot.findCampaignsByTags).toHaveBeenCalledWith([
      'typescript',
      'react',
    ]);
    expect(mlEngine.getEmbedding).toHaveBeenCalledTimes(1);
    const metricsMock = metrics as unknown as {
      incRtbEmbeddingSource: jest.Mock;
      recordRtbLexicalFallback: jest.Mock;
    };
    expect(metricsMock.incRtbEmbeddingSource).toHaveBeenCalledWith('fallback');
    expect(metricsMock.recordRtbLexicalFallback).toHaveBeenCalledWith(
      'miss',
      2
    );
  });

  it('3B-M2: model-not-ready still serves lexical candidates without runtime', async () => {
    const campaign = buildCampaign('c1', ['react'], {});
    const repository = buildRepository([campaign]);
    const snapshot = buildSnapshot([campaign]);
    const mlEngine = buildMlEngine() as unknown as {
      isReady: jest.Mock;
      getEmbedding: jest.Mock;
    };
    mlEngine.isReady.mockReturnValue(false);
    const metrics = buildMetricsService();
    const matcher = buildMatcher(
      repository,
      snapshot,
      mlEngine as unknown as MLEngine,
      metrics,
      buildConfigService({
        RTB_CAMPAIGN_SOURCE: 'local_snapshot',
        RTB_EMBEDDING_COLD_MISS_FAST_PATH_ENABLED: 'true',
      })
    );

    const candidates = await matcher.findCandidatesByTags({
      blogKey: 'blog',
      blogId: 1,
      blogName: 'blog',
      tags: ['react'],
      postUrl: 'https://example.com/post',
      behaviorScore: 20,
      isHighIntent: false,
    });

    expect(candidates.map((candidate) => candidate.id)).toEqual(['c1']);
    expect(mlEngine.getEmbedding).not.toHaveBeenCalled();
    const metricsMock = metrics as unknown as {
      recordRtbLexicalFallback: jest.Mock;
    };
    expect(metricsMock.recordRtbLexicalFallback).toHaveBeenCalledWith(
      'model_not_ready',
      1
    );
  });

  it('3D-M1: READY context embedding becomes the ANN query vector', async () => {
    const campaign = buildCampaign('c1', ['react'], { react: [0, 1] });
    const repository = buildRepository([campaign]);
    repository.searchCampaignTagVectors.mockResolvedValue([
      {
        campaignId: 'c1',
        tagName: 'react',
        distance: 0.01,
        similarity: 0.99,
      },
    ]);
    const metrics = buildMetricsService();
    const contextEmbeddingService = {
      resolveForDecision: jest
        .fn()
        .mockResolvedValue({ status: 'READY', embedding: [0, 1] }),
    } as unknown as ContextEmbeddingService;
    const mlEngine = buildMlEngine() as unknown as {
      getEmbedding: jest.Mock;
    };
    const matcher = buildMatcher(
      repository,
      buildSnapshot([campaign]),
      mlEngine as unknown as MLEngine,
      metrics,
      buildConfigService({
        RTB_MATCHER_ANN_ENABLED: 'true',
        RTB_CAMPAIGN_SOURCE: 'local_snapshot',
        RTB_CONTEXT_DECISION_ENABLED: 'true',
      }),
      contextEmbeddingService
    );

    const candidates = await matcher.findCandidatesByTags({
      blogKey: 'blog',
      blogId: 1,
      blogName: 'blog',
      tags: ['react'],
      contextId: `ctx_${'a'.repeat(64)}`,
      postUrl: 'https://example.com/post',
      behaviorScore: 20,
      isHighIntent: false,
    });

    expect(candidates.map((candidate) => candidate.id)).toEqual(['c1']);
    expect(repository.searchCampaignTagVectors).toHaveBeenCalledWith(
      expect.objectContaining({ queryEmbedding: [0, 1] })
    );
    expect(mlEngine.getEmbedding).not.toHaveBeenCalled();
    const metricsMock = metrics as unknown as {
      recordRtbContextDecision: jest.Mock;
      incRtbEmbeddingSource: jest.Mock;
    };
    expect(metricsMock.recordRtbContextDecision).toHaveBeenCalledWith('READY');
    expect(metricsMock.incRtbEmbeddingSource).toHaveBeenCalledWith('context');
  });

  it('3D-M2: PENDING context falls back to lexical candidates', async () => {
    const campaign = buildCampaign('c1', ['react'], {});
    const repository = buildRepository([campaign]);
    const metrics = buildMetricsService();
    const contextEmbeddingService = {
      resolveForDecision: jest.fn().mockResolvedValue({ status: 'PENDING' }),
    } as unknown as ContextEmbeddingService;
    const mlEngine = buildMlEngine() as unknown as {
      getEmbedding: jest.Mock;
    };
    const matcher = buildMatcher(
      repository,
      buildSnapshot([campaign]),
      mlEngine as unknown as MLEngine,
      metrics,
      buildConfigService({
        RTB_MATCHER_ANN_ENABLED: 'true',
        RTB_CAMPAIGN_SOURCE: 'local_snapshot',
        RTB_EMBEDDING_COLD_MISS_FAST_PATH_ENABLED: 'true',
        RTB_CONTEXT_DECISION_ENABLED: 'true',
      }),
      contextEmbeddingService
    );

    const candidates = await matcher.findCandidatesByTags({
      blogKey: 'blog',
      blogId: 1,
      blogName: 'blog',
      tags: ['react'],
      contextId: `ctx_${'b'.repeat(64)}`,
      postUrl: 'https://example.com/post',
      behaviorScore: 20,
      isHighIntent: false,
    });

    expect(candidates.map((candidate) => candidate.id)).toEqual(['c1']);
    expect(repository.searchCampaignTagVectors).not.toHaveBeenCalled();
    expect(mlEngine.getEmbedding).not.toHaveBeenCalled();
    const metricsMock = metrics as unknown as {
      recordRtbContextDecision: jest.Mock;
      recordRtbLexicalFallback: jest.Mock;
    };
    expect(metricsMock.recordRtbContextDecision).toHaveBeenCalledWith(
      'PENDING'
    );
    expect(metricsMock.recordRtbLexicalFallback).toHaveBeenCalledWith(
      'context_pending',
      1
    );
  });

  it('3B-M3: lexical rank prefers more exact matches then higher CPC on ties', async () => {
    // coverage = exact/requestSize 이므로 exact가 같으면 coverage도 같다 → CPC tie-break
    const twoExact = {
      ...buildCampaign('c-exact2', ['react', 'nestjs'], {}),
      maxCpc: 10,
    };
    const oneExactLowCpc = {
      ...buildCampaign('c-low', ['react'], {}),
      maxCpc: 10,
    };
    const oneExactHighCpc = {
      ...buildCampaign('c-high', ['react', 'redis'], {}),
      maxCpc: 999,
    };
    const campaigns = [oneExactLowCpc, oneExactHighCpc, twoExact];
    const matcher = buildMatcher(
      buildRepository(campaigns),
      buildSnapshot(campaigns),
      buildMlEngine(),
      buildMetricsService(),
      buildConfigService({
        RTB_CAMPAIGN_SOURCE: 'local_snapshot',
        RTB_EMBEDDING_COLD_MISS_FAST_PATH_ENABLED: 'true',
      })
    );

    const candidates = await matcher.findCandidatesByTags({
      blogKey: 'blog',
      blogId: 1,
      blogName: 'blog',
      tags: ['react', 'nestjs'],
      postUrl: 'https://example.com/post',
      behaviorScore: 20,
      isHighIntent: false,
    });

    expect(candidates.map((c) => c.id)).toEqual([
      'c-exact2',
      'c-high',
      'c-low',
    ]);
  });

  it('3B-M4: campaigns without embeddingTags remain lexical candidates', async () => {
    const campaign = buildCampaign('c1', ['react'], {});
    delete (campaign as { embeddingTags?: unknown }).embeddingTags;
    const matcher = buildMatcher(
      buildRepository([campaign]),
      buildSnapshot([campaign]),
      buildMlEngine(),
      buildMetricsService(),
      buildConfigService({
        RTB_CAMPAIGN_SOURCE: 'local_snapshot',
        RTB_EMBEDDING_COLD_MISS_FAST_PATH_ENABLED: 'true',
      })
    );

    const candidates = await matcher.findCandidatesByTags({
      blogKey: 'blog',
      blogId: 1,
      blogName: 'blog',
      tags: ['react'],
      postUrl: 'https://example.com/post',
      behaviorScore: 20,
      isHighIntent: false,
    });
    expect(candidates.map((c) => c.id)).toEqual(['c1']);
  });

  it('3B-M5: no tag overlap yields empty matcher candidates', async () => {
    const campaign = buildCampaign('c1', ['redis'], {});
    const metrics = buildMetricsService();
    const matcher = buildMatcher(
      buildRepository([campaign]),
      buildSnapshot([campaign]),
      buildMlEngine(),
      metrics,
      buildConfigService({
        RTB_CAMPAIGN_SOURCE: 'local_snapshot',
        RTB_EMBEDDING_COLD_MISS_FAST_PATH_ENABLED: 'true',
      })
    );

    const candidates = await matcher.findCandidatesByTags({
      blogKey: 'blog',
      blogId: 1,
      blogName: 'blog',
      tags: ['react'],
      postUrl: 'https://example.com/post',
      behaviorScore: 20,
      isHighIntent: false,
    });
    expect(candidates).toEqual([]);
    expect(
      (metrics as unknown as { incRtbFallback: jest.Mock }).incRtbFallback
    ).toHaveBeenCalledWith('matcher_empty');
  });

  it('3B-M6: cold-miss flag off awaits runtime resolve path', async () => {
    const repository = buildRepository([]);
    repository.getAllCampaigns.mockResolvedValue([]);
    const mlEngine = buildMlEngine() as unknown as {
      getEmbedding: jest.Mock;
    };
    const metrics = buildMetricsService();
    const matcher = buildMatcher(
      repository,
      buildSnapshot([]),
      mlEngine as unknown as MLEngine,
      metrics,
      buildConfigService({
        RTB_MATCHER_ANN_ENABLED: 'false',
        RTB_EMBEDDING_COLD_MISS_FAST_PATH_ENABLED: 'false',
      })
    );

    await matcher.findCandidatesByTags({
      blogKey: 'blog',
      blogId: 1,
      blogName: 'blog',
      tags: ['unique-cold-flag-off'],
      postUrl: 'https://example.com/post',
      behaviorScore: 20,
      isHighIntent: false,
    });

    expect(mlEngine.getEmbedding).toHaveBeenCalledTimes(1);
    expect(
      (metrics as unknown as { recordRtbLexicalFallback: jest.Mock })
        .recordRtbLexicalFallback
    ).not.toHaveBeenCalled();
    expect(
      (metrics as unknown as { incRtbEmbeddingSource: jest.Mock })
        .incRtbEmbeddingSource
    ).toHaveBeenCalledWith('runtime');
  });

  it('3D-M3: FAILED and TIMEOUT context fall back to lexical', async () => {
    const campaign = buildCampaign('c1', ['react'], {});
    for (const status of ['FAILED', 'TIMEOUT'] as const) {
      const metrics = buildMetricsService();
      const mlEngine = buildMlEngine() as unknown as {
        getEmbedding: jest.Mock;
      };
      const matcher = buildMatcher(
        buildRepository([campaign]),
        buildSnapshot([campaign]),
        mlEngine as unknown as MLEngine,
        metrics,
        buildConfigService({
          RTB_CAMPAIGN_SOURCE: 'local_snapshot',
          RTB_EMBEDDING_COLD_MISS_FAST_PATH_ENABLED: 'true',
          RTB_CONTEXT_DECISION_ENABLED: 'true',
        }),
        {
          resolveForDecision: jest.fn().mockResolvedValue({ status }),
        } as unknown as ContextEmbeddingService
      );
      const candidates = await matcher.findCandidatesByTags({
        blogKey: 'blog',
        blogId: 1,
        blogName: 'blog',
        tags: ['react'],
        contextId: `ctx_${status.padEnd(64, 'a').slice(0, 64)}`,
        postUrl: 'https://example.com/post',
        behaviorScore: 20,
        isHighIntent: false,
      });
      expect(candidates.map((c) => c.id)).toEqual(['c1']);
      expect(mlEngine.getEmbedding).not.toHaveBeenCalled();
      expect(
        (metrics as unknown as { recordRtbLexicalFallback: jest.Mock })
          .recordRtbLexicalFallback
      ).toHaveBeenCalledWith(`context_${status.toLowerCase()}`, 1);
    }
  });

  it('hydrates ANN candidates from the local snapshot when enabled', async () => {
    const campaign = buildCampaign('c1', ['typescript'], {
      typescript: [1, 0],
    });
    const repository = buildRepository([campaign]);
    repository.searchCampaignTagVectors.mockResolvedValue([
      {
        campaignId: 'c1',
        tagName: 'typescript',
        distance: 0.02,
        similarity: 0.98,
      },
    ]);
    const snapshot = buildSnapshot([campaign]);
    const metrics = buildMetricsService();

    const matcher = buildMatcher(
      repository,
      snapshot,
      buildMlEngine(),
      metrics,
      buildConfigService({
        RTB_MATCHER_ANN_ENABLED: 'true',
        RTB_CAMPAIGN_SOURCE: 'local_snapshot',
      })
    );

    await matcher.findCandidatesByTags({
      blogKey: 'blog',
      blogId: 1,
      blogName: 'blog',
      tags: ['typescript'],
      postUrl: 'https://example.com/post',
      behaviorScore: 20,
      isHighIntent: false,
    });

    expect(snapshot.findCampaignsByIds).toHaveBeenCalledWith(['c1']);
    expect(repository.findCampaignCachesByIds).not.toHaveBeenCalled();
    const metricsMock = metrics as unknown as {
      recordRtbStage: jest.Mock;
    };
    expect(metricsMock.recordRtbStage).toHaveBeenCalledWith(
      'match_campaign_hydrate_snapshot',
      'ok',
      expect.any(Number)
    );
  });

  it('keeps candidate ranking identical between Redis and snapshot hydration', async () => {
    const first = buildCampaign('c1', ['typescript'], {
      typescript: [1, 0],
    });
    const second = buildCampaign('c2', ['react'], {
      react: [0.8, 0.2],
    });
    const campaigns = [first, second];
    const repository = buildRepository(campaigns);
    repository.searchCampaignTagVectors.mockResolvedValue([
      {
        campaignId: 'c1',
        tagName: 'typescript',
        distance: 0.02,
        similarity: 0.98,
      },
      {
        campaignId: 'c2',
        tagName: 'react',
        distance: 0.1,
        similarity: 0.9,
      },
    ]);
    const context = {
      blogKey: 'blog',
      blogId: 1,
      blogName: 'blog',
      tags: ['typescript', 'react'],
      postUrl: 'https://example.com/post',
      behaviorScore: 20,
      isHighIntent: false,
    };
    const build = (campaignSource: 'redis_json' | 'local_snapshot') =>
      buildMatcher(
        repository,
        buildSnapshot(campaigns),
        buildMlEngine(),
        buildMetricsService(),
        buildConfigService({
          RTB_MATCHER_ANN_ENABLED: 'true',
          RTB_CAMPAIGN_SOURCE: campaignSource,
        })
      );

    const [redisCandidates, snapshotCandidates] = await Promise.all([
      build('redis_json').findCandidatesByTags(context),
      build('local_snapshot').findCandidatesByTags(context),
    ]);

    expect(
      snapshotCandidates.map(({ id, score, similarity }) => ({
        id,
        score,
        similarity,
      }))
    ).toEqual(
      redisCandidates.map(({ id, score, similarity }) => ({
        id,
        score,
        similarity,
      }))
    );
    expect(snapshotCandidates[0]?.id).toBe(redisCandidates[0]?.id);
  });
});
