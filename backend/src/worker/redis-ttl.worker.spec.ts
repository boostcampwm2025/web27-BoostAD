import { ConfigService } from '@nestjs/config';
import { CacheRepository } from '../cache/repository/cache.repository.interface';
import { CampaignCacheRepository } from '../campaign/repository/campaign.cache.repository.interface';
import type { AppIORedisClient } from '../redis/redis.type';
import { RedisTTLWorker } from './redis-ttl.worker';

function buildWorker() {
  const subscriber = {
    subscribe: jest.fn().mockResolvedValue(1),
    unsubscribe: jest.fn().mockResolvedValue(1),
    on: jest.fn(),
    disconnect: jest.fn(),
  };
  const redis = {
    config: jest.fn().mockResolvedValue('OK'),
    duplicate: jest.fn(() => subscriber),
  } as unknown as AppIORedisClient;
  const cacheRepository = {} as CacheRepository;
  const campaignCacheRepository = {
    findExpiredAuctionIds: jest.fn().mockResolvedValue([]),
    releaseAuction: jest.fn().mockResolvedValue({ outcome: 'released' }),
  };
  const config = {
    get: jest.fn((_key: string, defaultValue?: string) => defaultValue),
  } as unknown as ConfigService;
  const worker = new RedisTTLWorker(
    redis,
    cacheRepository,
    campaignCacheRepository as unknown as CampaignCacheRepository,
    config
  );
  return { worker, campaignCacheRepository, subscriber };
}

describe('RedisTTLWorker reservation expiration sweep', () => {
  it('releases expired Decisions even when no View was recorded', async () => {
    const { worker, campaignCacheRepository } = buildWorker();
    campaignCacheRepository.findExpiredAuctionIds.mockResolvedValueOnce([
      'auction-without-view',
    ]);

    await worker.sweepExpiredReservations();

    expect(campaignCacheRepository.releaseAuction).toHaveBeenCalledWith(
      'auction-without-view',
      1800
    );
  });

  it('does not overlap sweeps when one batch is still running', async () => {
    const { worker, campaignCacheRepository } = buildWorker();
    let resolveFind!: (ids: string[]) => void;
    campaignCacheRepository.findExpiredAuctionIds.mockReturnValueOnce(
      new Promise<string[]>((resolve) => {
        resolveFind = resolve;
      })
    );

    const first = worker.sweepExpiredReservations();
    await worker.sweepExpiredReservations();
    expect(campaignCacheRepository.findExpiredAuctionIds).toHaveBeenCalledTimes(
      1
    );

    resolveFind([]);
    await first;
  });

  it('starts recovery on module init and keeps the legacy Pub/Sub subscriber', async () => {
    const { worker, campaignCacheRepository, subscriber } = buildWorker();
    campaignCacheRepository.findExpiredAuctionIds.mockResolvedValueOnce([
      'auction-after-restart',
    ]);

    await worker.onModuleInit();
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(campaignCacheRepository.releaseAuction).toHaveBeenCalledWith(
      'auction-after-restart',
      1800
    );
    expect(subscriber.subscribe).toHaveBeenCalledWith('__keyevent@0__:expired');

    await worker.onModuleDestroy();
  });
});
