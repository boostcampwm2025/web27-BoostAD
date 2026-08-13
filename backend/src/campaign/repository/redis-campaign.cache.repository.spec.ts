import { ConfigService } from '@nestjs/config';
import { EventEmitter2 } from '@nestjs/event-emitter';
import type { AppIORedisClient } from 'src/redis/redis.type';
import { RedisCampaignCacheRepository } from './redis-campaign.cache.repository';

describe('RedisCampaignCacheRepository winner-only reservation', () => {
  const buildRepository = (evalResult: [number, number]) => {
    const redis = {
      eval: jest.fn().mockResolvedValue(evalResult),
    } as unknown as AppIORedisClient & { eval: jest.Mock };
    const config = {
      get: jest.fn((_key: string, defaultValue: number) => defaultValue),
    } as unknown as ConfigService;

    return {
      repository: new RedisCampaignCacheRepository(
        redis,
        config,
        new EventEmitter2()
      ),
      redis,
    };
  };

  it('maps the Lua selected index back to the ranked campaign ID', async () => {
    const { repository, redis } = buildRepository([2, 2]);

    const result = await repository.reserveFirstAvailable([
      { campaignId: 'first', cpc: 10 },
      { campaignId: 'second', cpc: 20 },
    ]);

    expect(result).toEqual({ campaignId: 'second', attemptedCount: 2 });
    expect(redis.eval).toHaveBeenCalledWith(
      expect.any(String),
      2,
      'campaign:first',
      'campaign:second',
      '10',
      '20'
    );
  });

  it('returns null when no campaign in the window is reservable', async () => {
    const { repository } = buildRepository([0, 2]);

    await expect(
      repository.reserveFirstAvailable([
        { campaignId: 'first', cpc: 10 },
        { campaignId: 'second', cpc: 20 },
      ])
    ).resolves.toBeNull();
  });

  it('rejects campaign vectors from a different model space', async () => {
    const { repository } = buildRepository([0, 0]);

    await expect(
      repository.updateCampaignEmbeddings('campaign-1', {
        modelVersion: 'other-model',
        document: Array<number>(384).fill(0),
        tags: { react: Array<number>(384).fill(0) },
      })
    ).rejects.toThrow('campaign embedding model version 불일치');
  });

  it('uses a model-versioned document index for multilingual E5', async () => {
    const redis = {
      call: jest.fn((command: string) => {
        if (command === 'FT.INFO') {
          return Promise.reject(new Error('Unknown index name'));
        }
        if (command === 'FT.SEARCH') {
          return Promise.resolve([
            1,
            'campaign-doc-vec:key',
            ['campaignId', 'campaign-1', 'vector_distance', '0.2'],
          ]);
        }
        return Promise.resolve('OK');
      }),
    } as unknown as AppIORedisClient & { call: jest.Mock };
    const config = {
      get: jest.fn((key: string, defaultValue?: number) => {
        if (key === 'RTB_EMBEDDING_PROFILE') {
          return 'multilingual_e5_small';
        }
        return defaultValue;
      }),
    } as unknown as ConfigService;
    const repository = new RedisCampaignCacheRepository(
      redis,
      config,
      new EventEmitter2()
    );

    await expect(
      repository.searchCampaignDocumentVectors({
        queryEmbedding: Array<number>(384).fill(0),
        topL: 10,
        isHighIntent: false,
        nowTs: Date.now(),
      })
    ).resolves.toEqual([
      {
        campaignId: 'campaign-1',
        distance: 0.2,
        similarity: 0.8,
      },
    ]);

    const createCall = redis.call.mock.calls.find(
      ([command]) => command === 'FT.CREATE'
    );
    expect(createCall).toEqual(
      expect.arrayContaining([
        'FT.CREATE',
        'idx:campaign_doc_vec:xenova-multilingual-e5-small-retrieval-v1-mean-normalized',
        'campaign-doc-vec:xenova-multilingual-e5-small-retrieval-v1-mean-normalized:',
        '384',
      ])
    );
  });
});
