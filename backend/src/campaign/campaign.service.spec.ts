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

  const buildService = (cached: CachedCampaign | null, job?: object) => {
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
      embeddingQueue as never
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
      { campaignId: campaign.id },
      expect.objectContaining({
        jobId: `campaign-embedding-${campaign.id}`,
        attempts: 3,
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
