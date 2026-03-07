import {
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectQueue } from '@nestjs/bullmq';
import { InjectDataSource } from '@nestjs/typeorm';
import { Queue } from 'bullmq';
import { DataSource, In } from 'typeorm';
import { IOREDIS_CLIENT } from 'src/redis/redis.constant';
import type { AppIORedisClient } from 'src/redis/redis.type';
import { CampaignCacheRepository } from 'src/campaign/repository/campaign.cache.repository.interface';
import { CampaignEntity } from 'src/campaign/entities/campaign.entity';
import { ViewLogEntity } from 'src/log/entities/view-log.entity';
import { ClickLogEntity } from 'src/log/entities/click-log.entity';
import { BidLogEntity } from 'src/bid-log/entities/bid-log.entity';
import { ResetRtbStateDto } from './dto/reset-rtb-state.dto';

type QueueCounts = {
  active: number;
  waiting: number;
  delayed: number;
  prioritized: number;
  paused: number;
  completed: number;
  failed: number;
};

type ResetCounts = {
  dbCampaignsReset: number;
  redisCampaignsReset: number;
  deletedBidLogs: number;
  deletedViewLogs: number;
  deletedClickLogs: number;
  deletedRedisKeys: number;
  drainedBidlogJobs: number;
};

@Injectable()
export class LoadtestService {
  private readonly redisResetPatterns = [
    'auction:*',
    'rollback:view:*',
    'backup:rollback:view:*',
    'dedup:view:*',
    'dedup:click:*',
  ];

  constructor(
    private readonly configService: ConfigService,
    @InjectDataSource() private readonly dataSource: DataSource,
    @Inject(IOREDIS_CLIENT) private readonly ioRedisClient: AppIORedisClient,
    @Inject(CampaignCacheRepository)
    private readonly campaignCacheRepository: CampaignCacheRepository,
    @InjectQueue('bidlog-queue')
    private readonly bidlogQueue: Queue
  ) {}

  async resetRtbState(
    dto: ResetRtbStateDto,
    providedToken?: string
  ): Promise<{
    scopedCampaignIds: string[];
    queueBefore: QueueCounts;
    queueAfter: QueueCounts;
    counts: ResetCounts;
  }> {
    this.assertResetAllowed(providedToken);

    const options = {
      force: dto.force ?? false,
      clearLogs: dto.clearLogs ?? true,
      clearAuxRedisKeys: dto.clearAuxRedisKeys ?? true,
      drainBidlogQueue: dto.drainBidlogQueue ?? true,
    };

    const queueBefore = await this.getBidlogQueueCounts();
    await this.ensureQueueResettable(queueBefore, options.force);

    let drainedBidlogJobs = 0;
    if (options.drainBidlogQueue) {
      drainedBidlogJobs = await this.drainPendingBidlogQueue();
    }

    const scopedCampaignIds = await this.resolveTargetCampaignIds(
      dto.campaignIds
    );
    const counts = await this.resetDatabaseState(
      scopedCampaignIds,
      options.clearLogs
    );

    counts.redisCampaignsReset = await this.resetRedisCampaignState(
      scopedCampaignIds
    );
    counts.drainedBidlogJobs = drainedBidlogJobs;

    if (options.clearAuxRedisKeys) {
      counts.deletedRedisKeys = await this.deleteAuxiliaryRedisKeys();
    }

    const queueAfter = await this.getBidlogQueueCounts();

    return {
      scopedCampaignIds,
      queueBefore,
      queueAfter,
      counts,
    };
  }

  private assertResetAllowed(providedToken?: string): void {
    const enabled =
      this.configService.get<string>('LOADTEST_RESET_ENABLED') === 'true';
    if (!enabled) {
      throw new ForbiddenException(
        'LOADTEST_RESET_ENABLED=true 인 경우에만 reset endpoint를 사용할 수 있습니다.'
      );
    }

    const expectedToken = this.configService.get<string>('LOADTEST_RESET_TOKEN');
    if (!expectedToken) {
      throw new ServiceUnavailableException(
        'LOADTEST_RESET_TOKEN이 설정되지 않아 reset endpoint를 사용할 수 없습니다.'
      );
    }

    if (!providedToken || providedToken !== expectedToken) {
      throw new UnauthorizedException('유효한 loadtest reset token이 필요합니다.');
    }
  }

  private async resolveTargetCampaignIds(
    requestedCampaignIds?: string[]
  ): Promise<string[]> {
    const campaignRepo = this.dataSource.getRepository(CampaignEntity);

    if (requestedCampaignIds && requestedCampaignIds.length > 0) {
      const campaigns = await campaignRepo.find({
        where: { id: In(requestedCampaignIds) },
        select: { id: true },
      });

      return campaigns.map((campaign) => campaign.id);
    }

    const campaigns = await campaignRepo.find({
      where: {},
      select: { id: true },
    });

    return campaigns.map((campaign) => campaign.id);
  }

  private async resetDatabaseState(
    campaignIds: string[],
    clearLogs: boolean
  ): Promise<ResetCounts> {
    const now = new Date();

    return await this.dataSource.transaction(async (manager) => {
      const campaignRepo = manager.getRepository(CampaignEntity);
      const viewLogRepo = manager.getRepository(ViewLogEntity);
      const clickLogRepo = manager.getRepository(ClickLogEntity);
      const bidLogRepo = manager.getRepository(BidLogEntity);

      let deletedClickLogs = 0;
      let deletedViewLogs = 0;
      let deletedBidLogs = 0;

      if (clearLogs) {
        if (campaignIds.length > 0) {
          const viewLogs = await viewLogRepo.find({
            where: { campaignId: In(campaignIds) },
            select: { id: true },
          });
          const viewIds = viewLogs.map((viewLog) => viewLog.id);

          if (viewIds.length > 0) {
            const clickDeleteResult = await clickLogRepo.delete({
              viewId: In(viewIds),
            });
            deletedClickLogs = clickDeleteResult.affected ?? 0;
          }

          const viewDeleteResult = await viewLogRepo.delete({
            campaignId: In(campaignIds),
          });
          deletedViewLogs = viewDeleteResult.affected ?? 0;

          const bidDeleteResult = await bidLogRepo.delete({
            campaignId: In(campaignIds),
          });
          deletedBidLogs = bidDeleteResult.affected ?? 0;
        } else {
          const clickDeleteResult = await clickLogRepo
            .createQueryBuilder()
            .delete()
            .execute();
          deletedClickLogs = clickDeleteResult.affected ?? 0;

          const viewDeleteResult = await viewLogRepo
            .createQueryBuilder()
            .delete()
            .execute();
          deletedViewLogs = viewDeleteResult.affected ?? 0;

          const bidDeleteResult = await bidLogRepo
            .createQueryBuilder()
            .delete()
            .execute();
          deletedBidLogs = bidDeleteResult.affected ?? 0;
        }
      }

      let dbCampaignsReset = 0;

      if (campaignIds.length > 0) {
        const updateResult = await campaignRepo.update(
          { id: In(campaignIds) },
          {
            dailySpent: 0,
            totalSpent: 0,
            lastResetDate: now,
          }
        );
        dbCampaignsReset = updateResult.affected ?? 0;
      }

      return {
        dbCampaignsReset,
        redisCampaignsReset: 0,
        deletedBidLogs,
        deletedViewLogs,
        deletedClickLogs,
        deletedRedisKeys: 0,
        drainedBidlogJobs: 0,
      };
    });
  }

  private async resetRedisCampaignState(campaignIds: string[]): Promise<number> {
    let resetCount = 0;
    const resetTimestamp = new Date().toISOString();

    for (const campaignId of campaignIds) {
      const cached =
        await this.campaignCacheRepository.findCampaignCacheById(campaignId);

      if (!cached) {
        continue;
      }

      await this.campaignCacheRepository.saveCampaignCacheById(campaignId, {
        ...cached,
        dailySpent: 0,
        totalSpent: 0,
        lastResetDate: resetTimestamp,
      });
      resetCount += 1;
    }

    return resetCount;
  }

  private async deleteAuxiliaryRedisKeys(): Promise<number> {
    let deletedKeys = 0;

    for (const pattern of this.redisResetPatterns) {
      deletedKeys += await this.deleteKeysByPattern(pattern);
    }

    return deletedKeys;
  }

  private async deleteKeysByPattern(pattern: string): Promise<number> {
    let cursor = '0';
    let deleted = 0;

    do {
      const [nextCursor, keys] = (await this.ioRedisClient.scan(
        cursor,
        'MATCH',
        pattern,
        'COUNT',
        '200'
      )) as [string, string[]];

      cursor = nextCursor;

      if (keys.length > 0) {
        deleted += await this.ioRedisClient.del(...keys);
      }
    } while (cursor !== '0');

    return deleted;
  }

  private async getBidlogQueueCounts(): Promise<QueueCounts> {
    const counts = await this.bidlogQueue.getJobCounts(
      'active',
      'waiting',
      'delayed',
      'prioritized',
      'paused',
      'completed',
      'failed'
    );

    return {
      active: counts.active ?? 0,
      waiting: counts.waiting ?? 0,
      delayed: counts.delayed ?? 0,
      prioritized: counts.prioritized ?? 0,
      paused: counts.paused ?? 0,
      completed: counts.completed ?? 0,
      failed: counts.failed ?? 0,
    };
  }

  private async ensureQueueResettable(
    queueCounts: QueueCounts,
    force: boolean
  ): Promise<void> {
    if (queueCounts.active > 0) {
      throw new ConflictException(
        `bidlog-queue active job이 ${queueCounts.active}개 있어 reset할 수 없습니다.`
      );
    }

    const pendingJobs =
      queueCounts.waiting + queueCounts.delayed + queueCounts.prioritized;

    if (pendingJobs > 0 && !force) {
      throw new ConflictException(
        `bidlog-queue pending job이 ${pendingJobs}개 있습니다. force=true로 재시도하거나 queue를 먼저 비워주세요.`
      );
    }
  }

  private async drainPendingBidlogQueue(): Promise<number> {
    const counts = await this.getBidlogQueueCounts();
    const pendingJobs = counts.waiting + counts.delayed + counts.prioritized;

    if (pendingJobs === 0) {
      return 0;
    }

    await this.bidlogQueue.drain(true);
    return pendingJobs;
  }
}
