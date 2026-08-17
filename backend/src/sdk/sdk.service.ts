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
import { ConfigService } from '@nestjs/config';
import { AUCTION_TERMINAL_TTL_SECONDS } from 'src/campaign/constants/auction-reservation.constants';
import type {
  ActiveAuctionReservation,
  AuctionReservationRecord,
} from 'src/campaign/types/campaign.types';
import type { SaveViewLog } from 'src/log/types/log.type';

@Injectable()
export class SdkService {
  private readonly logger = new Logger(SdkService.name);

  constructor(
    private readonly logRepository: LogRepository,
    private readonly cacheRepository: CacheRepository,
    private readonly campaignCacheRepository: CampaignCacheRepository,
    private readonly campaignRepository: CampaignRepository,
    private readonly blogRepository: BlogRepository,
    private readonly userRepository: UserRepository,
    private readonly configService: ConfigService
  ) {
    this.auctionTerminalTtlSeconds = this.getPositiveIntConfig(
      'RTB_AUCTION_TERMINAL_TTL_SECONDS',
      AUCTION_TERMINAL_TTL_SECONDS
    );
  }

  private readonly auctionTerminalTtlSeconds: number;

  async recordView(dto: CreateViewLogDto, visitorId: string) {
    const {
      auctionId,
      campaignId,
      postUrl,
      isHighIntent,
      behaviorScore,
      positionRatio,
    } = dto;

    const reservation =
      await this.campaignCacheRepository.getAuctionReservation(auctionId);
    if (reservation) {
      return this.recordReservedView(dto, visitorId, reservation);
    }

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

    const viewLog = await this.logRepository.getViewLog(viewId);
    if (!viewLog) {
      throw new BadRequestException('잘못된 요청입니다.');
    }

    const reservation =
      await this.campaignCacheRepository.getAuctionReservation(
        viewLog.auctionId
      );
    if (reservation) {
      return this.recordReservedClick(viewId, viewLog);
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

    return this.persistClick(viewId, viewLog, true);
  }

  async recordDismiss(dto: CreateDismissLogDto): Promise<void> {
    const { viewId } = dto;

    this.logger.debug(`[SDK Dismiss] 시작: viewId=${viewId}`);

    const viewLog = await this.logRepository.getViewLog(viewId);
    if (viewLog) {
      const reservation =
        await this.campaignCacheRepository.getAuctionReservation(
          viewLog.auctionId
        );
      if (reservation) {
        const transition = await this.campaignCacheRepository.releaseAuction(
          viewLog.auctionId,
          this.auctionTerminalTtlSeconds
        );
        this.logger.debug(
          `[SDK Dismiss] 예약 해제 결과: auction=${viewLog.auctionId}, outcome=${transition.outcome}`
        );
        return;
      }
    }

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

  private async recordReservedView(
    dto: CreateViewLogDto,
    visitorId: string,
    reservation: AuctionReservationRecord
  ): Promise<number> {
    if (!this.isActiveReservation(reservation)) {
      throw new NotFoundException('404 not found');
    }
    if (reservation.expiresAt <= Date.now()) {
      await this.campaignCacheRepository.releaseAuction(
        reservation.auctionId,
        this.auctionTerminalTtlSeconds
      );
      throw new NotFoundException('404 not found');
    }
    if (dto.campaignId !== reservation.campaignId) {
      throw new BadRequestException('낙찰 캠페인 정보가 일치하지 않습니다.');
    }

    const dedupResult = await this.cacheRepository.acquireViewIdempotencyKey(
      dto.postUrl,
      visitorId,
      dto.isHighIntent
    );
    if (dedupResult.status === 'exists') return dedupResult.viewId;
    if (dedupResult.status === 'locked') {
      const existingViewId =
        await this.cacheRepository.getViewIdByIdempotencyKey(
          dto.postUrl,
          visitorId,
          dto.isHighIntent
        );
      if (existingViewId !== null) return existingViewId;
      throw new ConflictException('중복 요청 처리 중입니다.');
    }

    const viewId = await this.logRepository.saveViewLog({
      auctionId: reservation.auctionId,
      campaignId: reservation.campaignId,
      blogId: reservation.blogId,
      postUrl: dto.postUrl,
      cost: reservation.cost,
      positionRatio: dto.positionRatio ?? null,
      isHighIntent: dto.isHighIntent,
      behaviorScore: dto.behaviorScore,
    });
    await this.cacheRepository.setViewIdempotencyKey(
      dto.postUrl,
      visitorId,
      dto.isHighIntent,
      viewId
    );
    return viewId;
  }

  private async recordReservedClick(
    viewId: number,
    viewLog: SaveViewLog
  ): Promise<number | null> {
    const transition = await this.campaignCacheRepository.commitAuction(
      viewLog.auctionId,
      this.getKstBudgetDate(Date.now()),
      this.auctionTerminalTtlSeconds
    );
    if (
      transition.outcome !== 'committed' &&
      transition.outcome !== 'already_committed'
    ) {
      this.logger.warn(
        `[SDK ClickLog] 확정할 수 없는 예약: auction=${viewLog.auctionId}, outcome=${transition.outcome}`
      );
      return null;
    }

    const isDup = await this.cacheRepository.setClickIdempotencyKey(viewId);
    if (isDup) {
      this.logger.debug(`[SDK ClickLog] 중복 클릭 무시: viewId=${viewId}`);
      return null;
    }
    return this.persistClick(viewId, viewLog, false);
  }

  private async persistClick(
    viewId: number,
    viewLog: SaveViewLog,
    deleteLegacyRollback: boolean
  ): Promise<number> {
    const clickId = await this.logRepository.saveClickLog({ viewId });

    if (deleteLegacyRollback) {
      await this.cacheRepository.deleteRollbackInfo(viewId);
      await this.cacheRepository.deleteRollbackBackup(viewId);
    }

    void this.campaignRepository.incrementSpent(
      viewLog.campaignId,
      viewLog.cost
    );
    this.logger.debug(
      `[SDK ClickLog] DB dailySpent 동기화: campaign=${viewLog.campaignId}, cost=+${viewLog.cost}`
    );

    await this.payPublisherRevenue(viewId);
    this.logger.log(
      `[SDK ClickLog] 클릭 기록 완료: viewId=${viewId}, clickId=${clickId}`
    );
    return clickId;
  }

  private async payPublisherRevenue(viewId: number): Promise<void> {
    try {
      const viewLogData =
        await this.logRepository.getBlogIdAndCostByViewId(viewId);
      if (!viewLogData) return;

      const { blogId, cost } = viewLogData;
      const publisherId = await this.blogRepository.getUserIdByBlogId(blogId);
      if (!publisherId) return;

      const isPublisher = await this.userRepository.verifyRole(
        publisherId,
        UserRole.PUBLISHER
      );
      if (!isPublisher) {
        this.logger.debug(
          `[SDK ClickLog] 수익 지급 스킵: userId=${publisherId}는 퍼블리셔가 아님`
        );
        return;
      }

      const revenue = Math.floor(cost * 0.8);
      await this.userRepository.incrementBalance(publisherId, revenue);
      this.logger.log(
        `[SDK ClickLog] 퍼블리셔 수익 지급: publisherId=${publisherId}, revenue=${revenue} (cost=${cost})`
      );
    } catch (error) {
      this.logger.error(
        `[SDK ClickLog] 퍼블리셔 수익 지급 실패: viewId=${viewId}`,
        error
      );
    }
  }

  private isActiveReservation(
    reservation: AuctionReservationRecord
  ): reservation is ActiveAuctionReservation {
    return reservation.status === 'RESERVED' && 'campaignId' in reservation;
  }

  private getPositiveIntConfig(name: string, fallback: number): number {
    const parsed = Number(this.configService.get<string>(name));
    return Number.isFinite(parsed) && parsed > 0
      ? Math.floor(parsed)
      : fallback;
  }

  private getKstBudgetDate(epochMs: number): string {
    return new Date(epochMs + 9 * 60 * 60 * 1000).toISOString().slice(0, 10);
  }
}
