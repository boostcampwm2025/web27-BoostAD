import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { CreateViewLogDto } from './dto/create-view-log.dto';
import { LogRepository } from 'src/log/repository/log.repository.interface';
import { CacheRepository } from 'src/cache/repository/cache.repository.interface';
import { CreateClickLogDto } from './dto/create-click-log.dto';
import { CreateDismissLogDto } from './dto/create-dismiss-log.dto';
import { CampaignCacheRepository } from 'src/campaign/repository/campaign.cache.repository.interface';
import { CampaignRepository } from 'src/campaign/repository/campaign.repository.interface';
import { BlogRepository } from 'src/blog/repository/blog.repository.interface';
import { UserRepository } from 'src/user/repository/user.repository.interface';
import { UserRole } from 'src/user/entities/user.entity';

@Injectable()
export class SdkService {
  private readonly logger = new Logger(SdkService.name);

  constructor(
    private readonly logRepository: LogRepository,
    private readonly cacheRepository: CacheRepository,
    private readonly campaignCacheRepository: CampaignCacheRepository,
    private readonly campaignRepository: CampaignRepository,
    private readonly blogRepository: BlogRepository,
    private readonly userRepository: UserRepository
  ) {}

  async recordView(dto: CreateViewLogDto, visitorId: string) {
    const {
      auctionId,
      campaignId,
      postUrl,
      isHighIntent,
      behaviorScore,
      positionRatio,
    } = dto;

    const auctionData = await this.cacheRepository.getAuctionData(auctionId);
    if (!auctionData) {
      throw new NotFoundException('404 not found');
    }

    const { blogId, cost } = auctionData;

    const dedupResult = await this.cacheRepository.acquireViewIdempotencyKey(
      postUrl,
      visitorId,
      isHighIntent
    );
    if (dedupResult.status === 'exists') {
      const existingViewId = dedupResult.viewId;

      // 중복 viewId의 경우 Rollback 정보가 없을 수 있으므로 재생성
      const existingRollback =
        await this.cacheRepository.getRollbackInfo(existingViewId);
      if (!existingRollback) {
        this.logger.debug(
          `[SDK ViewLog] 중복 viewId=${existingViewId} Rollback 정보 재생성: campaign=${campaignId}, cost=${cost}`
        );
        await this.cacheRepository.setRollbackInfo(existingViewId, {
          campaignId,
          cost,
          createdAt: new Date().toISOString(),
        });

        // Rollback 백업 정보 저장 (기본 TTL - Worker용)
        await this.cacheRepository.setRollbackBackup(existingViewId, {
          campaignId,
          cost,
          createdAt: new Date().toISOString(),
        });
      }

      return existingViewId;
    }

    if (dedupResult.status === 'locked') {
      const existingViewId =
        await this.cacheRepository.getViewIdByIdempotencyKey(
          postUrl,
          visitorId,
          isHighIntent
        );
      if (existingViewId !== null) {
        return existingViewId;
      }
      throw new ConflictException('중복 요청 처리 중입니다.');
    }

    const viewId = await this.logRepository.saveViewLog({
      auctionId,
      campaignId,
      blogId,
      postUrl,
      cost,
      positionRatio: positionRatio ?? null,
      isHighIntent,
      behaviorScore,
    });

    await this.cacheRepository.setViewIdempotencyKey(
      postUrl,
      visitorId,
      isHighIntent,
      viewId
    );

    // Rollback 정보 Redis 저장 (기본 TTL)
    await this.cacheRepository.setRollbackInfo(viewId, {
      campaignId,
      cost,
      createdAt: new Date().toISOString(),
    });

    // Rollback 백업 정보 저장 (기본 TTL - Worker용)
    await this.cacheRepository.setRollbackBackup(viewId, {
      campaignId,
      cost,
      createdAt: new Date().toISOString(),
    });

    this.logger.debug(
      `[SDK ViewLog] Rollback 정보 저장: viewId=${viewId}, campaign=${campaignId}, cost=${cost} (TTL + Backup)`
    );

    return viewId;
  }

  async recordClick(dto: CreateClickLogDto): Promise<number | null> {
    const { viewId } = dto;

    const exists = await this.logRepository.existsByViewId(viewId);
    if (!exists) {
      throw new BadRequestException('잘못된 요청입니다.');
    }

    // Dismiss/TTL 만료 후 클릭 방지: rollbackInfo 또는 backup이 없으면 이미 롤백된 것
    const rollbackInfo = await this.cacheRepository.getRollbackInfo(viewId);
    const rollbackBackup = await this.cacheRepository.getRollbackBackup(viewId);

    if (!rollbackInfo && !rollbackBackup) {
      this.logger.warn(
        `[SDK ClickLog] 롤백된 View 클릭 시도: viewId=${viewId} (Dismiss/TTL 만료 후 클릭 무효)`
      );
      return null;
    }
    const isDup = await this.cacheRepository.setClickIdempotencyKey(viewId);

    if (isDup) {
      this.logger.debug(`[SDK ClickLog] 중복 클릭 무시: viewId=${viewId}`);
      return null;
    }

    const clickId = await this.logRepository.saveClickLog({ viewId });

    // 클릭 시 Rollback 정보 + 백업 삭제 (Dismiss Beacon이 와도 무시되도록)
    await this.cacheRepository.deleteRollbackInfo(viewId);
    await this.cacheRepository.deleteRollbackBackup(viewId);

    // DB dailySpent 동기화: ClickLog 저장과 함께 DB에도 spent 증가
    const viewLog = await this.logRepository.getViewLog(viewId);
    if (viewLog) {
      this.campaignRepository.incrementSpent(viewLog.campaignId, viewLog.cost); // await 기다릴 필요 없음
      this.logger.debug(
        `[SDK ClickLog] DB dailySpent 동기화: campaign=${viewLog.campaignId}, cost=+${viewLog.cost}`
      );
    }

    this.logger.log(
      `[SDK ClickLog] 클릭 기록 완료: viewId=${viewId}, clickId=${clickId} (Rollback 삭제 + DB 동기화)`
    );

    // 퍼블리셔 수익 지급 (cost의 80%, PUBLISHER만)
    try {
      const viewLogData =
        await this.logRepository.getBlogIdAndCostByViewId(viewId);
      if (viewLogData) {
        const { blogId, cost } = viewLogData;
        // TODO(Blog)(보류): Redis에서 불러오면 더 빠르지 않을까 싶음 - 비딩 성능에 직접적 영향 X
        const publisherId = await this.blogRepository.getUserIdByBlogId(blogId);

        if (publisherId) {
          // PUBLISHER 역할 확인
          const isPublisher = await this.userRepository.verifyRole(
            publisherId,
            UserRole.PUBLISHER
          );

          if (isPublisher) {
            const revenue = Math.floor(cost * 0.8);
            await this.userRepository.incrementBalance(publisherId, revenue);
            this.logger.log(
              `[SDK ClickLog] 퍼블리셔 수익 지급: publisherId=${publisherId}, revenue=${revenue} (cost=${cost})`
            );
          } else {
            this.logger.debug(
              `[SDK ClickLog] 수익 지급 스킵: userId=${publisherId}는 퍼블리셔가 아님`
            );
          }
        }
      }
    } catch (error) {
      this.logger.error(
        `[SDK ClickLog] 퍼블리셔 수익 지급 실패: viewId=${viewId}`,
        error
      );
      // 수익 지급 실패해도 클릭 로그는 유지
    }

    return clickId;
  }

  async recordDismiss(dto: CreateDismissLogDto): Promise<void> {
    const { viewId } = dto;

    this.logger.debug(`[SDK Dismiss] 시작: viewId=${viewId}`);

    // 1. Redis에서 Rollback 정보 조회
    const rollbackInfo = await this.cacheRepository.getRollbackInfo(viewId);
    if (!rollbackInfo) {
      // TTL 만료 또는 이미 처리됨 → 무시
      this.logger.warn(
        `[SDK Dismiss] RollbackInfo not found for viewId=${viewId} (TTL 만료 또는 이미 처리됨)`
      );
      return;
    }

    const { campaignId, cost, createdAt } = rollbackInfo;
    const elapsedMs = Date.now() - new Date(createdAt).getTime();

    this.logger.debug(
      `[SDK Dismiss] RollbackInfo 조회 성공: viewId=${viewId}, campaign=${campaignId}, cost=${cost}, elapsed=${Math.floor(elapsedMs / 1000)}s`
    );

    // 2. Spent 롤백 (Phase 2에서 구현된 메서드 사용)
    await this.campaignCacheRepository.decrementSpent(campaignId, cost);

    // 3. Redis에서 Rollback 정보 + 백업 삭제 (중복 방지)
    await this.cacheRepository.deleteRollbackInfo(viewId);
    await this.cacheRepository.deleteRollbackBackup(viewId);

    this.logger.log(
      `[SDK Dismiss] 롤백 완료: viewId=${viewId}, campaign=${campaignId}, cost=-${cost} (일일/총), elapsed=${Math.floor(elapsedMs / 1000)}s`
    );
  }
}
