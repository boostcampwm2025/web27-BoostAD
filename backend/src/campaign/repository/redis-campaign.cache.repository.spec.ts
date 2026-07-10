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
});
