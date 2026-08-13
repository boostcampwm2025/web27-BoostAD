import { CampaignService } from './campaign.service';
import type { CampaignWithTags, CachedCampaign } from './types/campaign.types';

describe('CampaignService initial cache loading', () => {
  const now = new Date('2026-07-10T00:00:00.000Z');
  const embedding = Array.from({ length: 384 }, (_, index) => index / 384);

  const campaign: CampaignWithTags = {
    id: 'campaign-1',
    userId: 1,
    title: 'campaign',
    content: 'content',
    image: null,
    url: 'https://example.com',
    maxCpc: 100,
    dailyBudget: 10000,
    totalBudget: 100000,
    dailySpent: 0,
    totalSpent: 0,
    lastResetDate: now,
    isHighIntent: false,
    status: 'ACTIVE',
    startDate: now,
    endDate: new Date('2026-08-10T00:00:00.000Z'),
    createdAt: now,
    deletedAt: null,
    tags: [{ id: 1, name: 'typescript' }],
  };

  const buildService = (
    cached: CachedCampaign | null,
    job?: object,
    config: {
      profile?: 'legacy_minilm' | 'multilingual_e5_small';
      denseMode?: 'legacy_tag' | 'semantic_document';
    } = {}
  ) => {
    const campaignRepository = {
      getAll: jest.fn().mockResolvedValue([campaign]),
    };
    const campaignCacheRepository = {
      findCampaignCacheById: jest.fn().mockResolvedValue(cached),
      saveCampaignCacheById: jest.fn().mockResolvedValue(undefined),
    };
    const embeddingQueue = {
      getJob: jest.fn().mockResolvedValue(job ?? null),
      add: jest.fn().mockResolvedValue(undefined),
    };

    const service = new CampaignService(
      campaignRepository as never,
      {} as never,
      campaignCacheRepository as never,
      {} as never,
      {} as never,
      embeddingQueue as never,
      {
        get: jest.fn((key: string) => {
          if (key === 'RTB_EMBEDDING_PROFILE') {
            return config.profile ?? 'legacy_minilm';
          }
          if (key === 'RTB_DENSE_RETRIEVAL_MODE') {
            return config.denseMode ?? 'legacy_tag';
          }
          return undefined;
        }),
      } as never
    );

    return {
      service: service as unknown as { loadAllCampaigns(): Promise<void> },
      campaignCacheRepository,
      embeddingQueue,
    };
  };

  it('preserves complete cached embeddings and does not enqueue regeneration', async () => {
    const cached = {
      ...toCachedCampaign(campaign),
      embeddingTags: { typescript: embedding },
      embeddingModelVersion:
        'Xenova/all-MiniLM-L6-v2@request-v1-mean-normalized',
    };
    const { service, campaignCacheRepository, embeddingQueue } =
      buildService(cached);

    await service.loadAllCampaigns();

    expect(campaignCacheRepository.saveCampaignCacheById).toHaveBeenCalledWith(
      campaign.id,
      expect.objectContaining({
        embeddingTags: { typescript: embedding },
      })
    );
    expect(embeddingQueue.getJob).not.toHaveBeenCalled();
    expect(embeddingQueue.add).not.toHaveBeenCalled();
  });

  it('removes a stale failed job and enqueues missing embeddings again', async () => {
    const failedJob = {
      getState: jest.fn().mockResolvedValue('failed'),
      remove: jest.fn().mockResolvedValue(undefined),
    };
    const { service, embeddingQueue } = buildService(
      toCachedCampaign(campaign),
      failedJob
    );

    await service.loadAllCampaigns();

    expect(failedJob.remove).toHaveBeenCalledTimes(1);
    expect(embeddingQueue.add).toHaveBeenCalledWith(
      'generate-campaign-embedding',
      {
        campaignId: campaign.id,
        modelVersion: 'Xenova/all-MiniLM-L6-v2@request-v1-mean-normalized',
      },
      expect.objectContaining({
        jobId:
          'campaign-embedding-xenova-all-minilm-l6-v2-request-v1-mean-normalized-campaign-1',
        attempts: 3,
      })
    );
  });

  it('removes a stale completed job and enqueues when embeddings are still missing', async () => {
    const completedJob = {
      getState: jest.fn().mockResolvedValue('completed'),
      remove: jest.fn().mockResolvedValue(undefined),
    };
    const { service, embeddingQueue } = buildService(
      toCachedCampaign(campaign),
      completedJob
    );

    await service.loadAllCampaigns();

    expect(completedJob.remove).toHaveBeenCalledTimes(1);
    expect(embeddingQueue.add).toHaveBeenCalledTimes(1);
  });

  it('does not reuse same-dimension embeddings from a different model', async () => {
    const cached = {
      ...toCachedCampaign(campaign),
      embeddingTags: { typescript: embedding },
      embeddingModelVersion:
        'Xenova/all-MiniLM-L6-v2@request-v1-mean-normalized',
    };
    const { service, campaignCacheRepository, embeddingQueue } = buildService(
      cached,
      undefined,
      { profile: 'multilingual_e5_small', denseMode: 'semantic_document' }
    );

    await service.loadAllCampaigns();

    expect(campaignCacheRepository.saveCampaignCacheById).toHaveBeenCalledWith(
      campaign.id,
      expect.not.objectContaining({ embeddingTags: expect.anything() })
    );
    expect(embeddingQueue.add).toHaveBeenCalledWith(
      'generate-campaign-embedding',
      {
        campaignId: campaign.id,
        modelVersion:
          'Xenova/multilingual-e5-small@retrieval-v1-mean-normalized',
      },
      expect.objectContaining({
        jobId:
          'campaign-embedding-xenova-multilingual-e5-small-retrieval-v1-mean-normalized-campaign-1',
      })
    );
  });
});

function toCachedCampaign(campaign: CampaignWithTags): CachedCampaign {
  return {
    ...campaign,
    image: campaign.image,
    totalBudget: campaign.totalBudget,
    lastResetDate: campaign.lastResetDate.toISOString(),
    startDate: campaign.startDate.toISOString(),
    endDate: campaign.endDate.toISOString(),
    createdAt: campaign.createdAt.toISOString(),
    deletedAt: campaign.deletedAt?.toISOString() ?? null,
    tags: campaign.tags.map((tag) => tag.name),
  };
}
