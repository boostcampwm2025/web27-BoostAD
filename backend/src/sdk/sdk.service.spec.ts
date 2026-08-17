import { ConfigService } from '@nestjs/config';
import { BlogRepository } from '../blog/repository/blog.repository.interface';
import { CacheRepository } from '../cache/repository/cache.repository.interface';
import { CampaignCacheRepository } from '../campaign/repository/campaign.cache.repository.interface';
import { CampaignRepository } from '../campaign/repository/campaign.repository.interface';
import type { ActiveAuctionReservation } from '../campaign/types/campaign.types';
import { LogRepository } from '../log/repository/log.repository.interface';
import type { SaveViewLog } from '../log/types/log.type';
import { UserRepository } from '../user/repository/user.repository.interface';
import { SdkService } from './sdk.service';

const reservation: ActiveAuctionReservation = {
  version: 1,
  auctionId: 'auction-1',
  campaignId: 'campaign-1',
  blogId: 7,
  cost: 100,
  status: 'RESERVED',
  budgetDate: '2026-08-17',
  createdAt: 1,
  updatedAt: 1,
  expiresAt: Date.now() + 60_000,
};

const viewLog: SaveViewLog = {
  auctionId: reservation.auctionId,
  campaignId: reservation.campaignId,
  blogId: reservation.blogId,
  postUrl: 'https://example.com/post',
  cost: reservation.cost,
  positionRatio: null,
  isHighIntent: false,
  behaviorScore: 50,
};

function buildHarness() {
  const logRepository = {
    existsByViewId: jest.fn().mockResolvedValue(true),
    saveViewLog: jest.fn().mockResolvedValue(42),
    getViewLog: jest.fn().mockResolvedValue(viewLog),
    saveClickLog: jest.fn().mockResolvedValue(84),
    getBlogIdAndCostByViewId: jest.fn().mockResolvedValue(null),
  };
  const cacheRepository = {
    getAuctionData: jest.fn(),
    acquireAuctionViewIdempotencyKey: jest
      .fn()
      .mockResolvedValue({ status: 'acquired' }),
    setAuctionViewIdempotencyKey: jest.fn(),
    getAuctionViewIdByIdempotencyKey: jest.fn().mockResolvedValue(null),
    getRollbackInfo: jest.fn().mockResolvedValue(null),
    getRollbackBackup: jest.fn().mockResolvedValue(null),
    setRollbackInfo: jest.fn(),
    setRollbackBackup: jest.fn(),
    setClickIdempotencyKey: jest.fn().mockResolvedValue(false),
    deleteRollbackInfo: jest.fn(),
    deleteRollbackBackup: jest.fn(),
  };
  const campaignCacheRepository = {
    getAuctionReservation: jest.fn().mockResolvedValue(null),
    commitAuction: jest
      .fn()
      .mockResolvedValue({ outcome: 'committed', reservation }),
    releaseAuction: jest
      .fn()
      .mockResolvedValue({ outcome: 'released', reservation }),
    decrementSpent: jest.fn(),
  };
  const campaignRepository = {
    incrementSpent: jest.fn(),
  };
  const blogRepository = {
    getUserIdByBlogId: jest.fn(),
  };
  const userRepository = {
    verifyRole: jest.fn(),
    incrementBalance: jest.fn(),
  };
  const configService = {
    get: jest.fn((_key: string, defaultValue?: string) => defaultValue),
  } as unknown as ConfigService;
  const service = new SdkService(
    logRepository as unknown as LogRepository,
    cacheRepository as unknown as CacheRepository,
    campaignCacheRepository as unknown as CampaignCacheRepository,
    campaignRepository as unknown as CampaignRepository,
    blogRepository as unknown as BlogRepository,
    userRepository as unknown as UserRepository,
    configService
  );

  return {
    service,
    logRepository,
    cacheRepository,
    campaignCacheRepository,
    campaignRepository,
  };
}

describe('SdkService auction reservation lifecycle', () => {
  it('records a winner-only View from the saved winner and CPC without rollback keys', async () => {
    const harness = buildHarness();
    harness.campaignCacheRepository.getAuctionReservation.mockResolvedValue(
      reservation
    );

    await expect(
      harness.service.recordView(
        {
          auctionId: reservation.auctionId,
          campaignId: reservation.campaignId,
          blogKey: 'blog-key',
          postUrl: 'https://example.com/post',
          isHighIntent: false,
          behaviorScore: 50,
        },
        'visitor-1'
      )
    ).resolves.toBe(42);

    expect(harness.logRepository.saveViewLog).toHaveBeenCalledWith(
      expect.objectContaining({
        auctionId: reservation.auctionId,
        campaignId: reservation.campaignId,
        blogId: reservation.blogId,
        cost: reservation.cost,
      })
    );
    expect(
      harness.cacheRepository.setAuctionViewIdempotencyKey
    ).toHaveBeenCalledWith(reservation.auctionId, 42);
    expect(harness.cacheRepository.getAuctionData).not.toHaveBeenCalled();
    expect(harness.cacheRepository.setRollbackInfo).not.toHaveBeenCalled();
    expect(harness.cacheRepository.setRollbackBackup).not.toHaveBeenCalled();
  });

  it('commits winner-only reserved budget on Click without legacy rollback keys', async () => {
    const harness = buildHarness();
    harness.campaignCacheRepository.getAuctionReservation.mockResolvedValue(
      reservation
    );

    await expect(
      harness.service.recordClick({
        viewId: 42,
        blogKey: 'blog-key',
        postUrl: 'https://example.com/post',
      })
    ).resolves.toBe(84);

    expect(harness.campaignCacheRepository.commitAuction).toHaveBeenCalledWith(
      reservation.auctionId,
      expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/),
      1800
    );
    expect(harness.logRepository.saveClickLog).toHaveBeenCalledWith({
      viewId: 42,
    });
    expect(harness.campaignRepository.incrementSpent).toHaveBeenCalledWith(
      reservation.campaignId,
      reservation.cost
    );
    expect(harness.cacheRepository.deleteRollbackInfo).not.toHaveBeenCalled();
    expect(harness.cacheRepository.deleteRollbackBackup).not.toHaveBeenCalled();
  });

  it('releases winner-only reserved budget on Dismiss', async () => {
    const harness = buildHarness();
    harness.campaignCacheRepository.getAuctionReservation.mockResolvedValue(
      reservation
    );

    await harness.service.recordDismiss({
      viewId: 42,
      blogKey: 'blog-key',
      postUrl: 'https://example.com/post',
    });

    expect(harness.campaignCacheRepository.releaseAuction).toHaveBeenCalledWith(
      reservation.auctionId,
      1800
    );
    expect(
      harness.campaignCacheRepository.decrementSpent
    ).not.toHaveBeenCalled();
  });

  it('treats a duplicate legacy click as a no-op', async () => {
    const harness = buildHarness();
    const rollbackInfo = {
      campaignId: 'campaign-1',
      cost: 100,
      createdAt: new Date().toISOString(),
    };
    harness.cacheRepository.getRollbackInfo.mockResolvedValue(rollbackInfo);
    harness.cacheRepository.getRollbackBackup.mockResolvedValue(rollbackInfo);
    harness.cacheRepository.setClickIdempotencyKey.mockResolvedValue(true);

    await expect(
      harness.service.recordClick({
        viewId: 42,
        blogKey: 'blog-key',
        postUrl: 'https://example.com/post',
      })
    ).resolves.toBeNull();

    expect(harness.cacheRepository.getRollbackInfo).toHaveBeenCalledTimes(1);
    expect(harness.logRepository.saveClickLog).not.toHaveBeenCalled();
    expect(
      harness.campaignCacheRepository.decrementSpent
    ).not.toHaveBeenCalled();
    expect(harness.cacheRepository.deleteRollbackInfo).not.toHaveBeenCalled();
    expect(harness.campaignRepository.incrementSpent).not.toHaveBeenCalled();
  });
});
