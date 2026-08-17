import { BlogRepository } from '../blog/repository/blog.repository.interface';
import { CacheRepository } from '../cache/repository/cache.repository.interface';
import { CampaignCacheRepository } from '../campaign/repository/campaign.cache.repository.interface';
import { CampaignRepository } from '../campaign/repository/campaign.repository.interface';
import { LogRepository } from '../log/repository/log.repository.interface';
import { UserRepository } from '../user/repository/user.repository.interface';
import { SdkService } from './sdk.service';

describe('SdkService recordClick idempotency', () => {
  it('treats a duplicate click as a no-op', async () => {
    const rollbackInfo = {
      campaignId: 'campaign-1',
      cost: 100,
      createdAt: new Date().toISOString(),
    };
    const getRollbackInfo = jest.fn().mockResolvedValue(rollbackInfo);
    const saveClickLog = jest.fn();
    const decrementSpent = jest.fn();
    const deleteRollbackInfo = jest.fn();
    const deleteRollbackBackup = jest.fn();
    const incrementSpent = jest.fn();
    const getUserIdByBlogId = jest.fn();
    const incrementBalance = jest.fn();
    const logRepository = {
      existsByViewId: jest.fn().mockResolvedValue(true),
      saveClickLog,
      getViewLog: jest.fn(),
      getBlogIdAndCostByViewId: jest.fn(),
    } as unknown as LogRepository;
    const cacheRepository = {
      getRollbackInfo,
      getRollbackBackup: jest.fn().mockResolvedValue(rollbackInfo),
      setClickIdempotencyKey: jest.fn().mockResolvedValue(true),
      deleteRollbackInfo,
      deleteRollbackBackup,
    } as unknown as CacheRepository;
    const campaignCacheRepository = {
      decrementSpent,
    } as unknown as CampaignCacheRepository;
    const campaignRepository = {
      incrementSpent,
    } as unknown as CampaignRepository;
    const blogRepository = {
      getUserIdByBlogId,
    } as unknown as BlogRepository;
    const userRepository = {
      verifyRole: jest.fn(),
      incrementBalance,
    } as unknown as UserRepository;
    const service = new SdkService(
      logRepository,
      cacheRepository,
      campaignCacheRepository,
      campaignRepository,
      blogRepository,
      userRepository
    );

    await expect(
      service.recordClick({
        viewId: 42,
        blogKey: 'blog-key',
        postUrl: 'https://example.com/post',
      })
    ).resolves.toBeNull();

    expect(getRollbackInfo).toHaveBeenCalledTimes(1);
    expect(saveClickLog).not.toHaveBeenCalled();
    expect(decrementSpent).not.toHaveBeenCalled();
    expect(deleteRollbackInfo).not.toHaveBeenCalled();
    expect(deleteRollbackBackup).not.toHaveBeenCalled();
    expect(incrementSpent).not.toHaveBeenCalled();
    expect(getUserIdByBlogId).not.toHaveBeenCalled();
    expect(incrementBalance).not.toHaveBeenCalled();
  });
});
