import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { ConfigService } from '@nestjs/config';
import { CampaignRepository } from './repository/campaign.repository.interface';
import { CampaignCacheRepository } from './repository/campaign.cache.repository.interface';
import { CampaignStatus } from './entities/campaign.entity';
import { ImageService } from '../image/image.service';
import { LogRepository } from '../log/repository/log.repository.interface';
import { CachedCampaign } from './types/campaign.types';

@Injectable()
export class CampaignCronService {
  private readonly logger = new Logger(CampaignCronService.name);
  private readonly isProduction: boolean;
  private readonly BATCH_SIZE = 10;

  constructor(
    private readonly campaignRepository: CampaignRepository,
    private readonly campaignCacheRepository: CampaignCacheRepository,
    private readonly imageService: ImageService,
    private readonly configService: ConfigService,
    private readonly logRepository: LogRepository
  ) {
    this.isProduction = this.configService.get('NODE_ENV') === 'production';
  }

  // ========================================
  // Phase 7: 일일 정산 (DB 동기화)
  // ========================================

  // 매일 자정에 일일 정산 실행 (통합 Cron)
  // 실행 순서: 종료처리 -> 정산 -> 리셋 -> 시작처리
  @Cron(CronExpression.EVERY_DAY_AT_MIDNIGHT)
  async scheduledDailyReconciliation(): Promise<void> {
    const startTime = Date.now();
    this.logger.log('===== 일일 정산 시작 =====');
    this.logger.log(
      `실행 시각: ${new Date().toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' })}`
    );

    try {
      // 0. Redis에서 한번만 로드
      const cachedCampaigns =
        await this.campaignCacheRepository.getAllCampaigns({
          allowStale: false,
        });
      this.logger.log(`Redis 캠페인 ${cachedCampaigns.length}개 로드`);

      // 1. 종료일 지난 캠페인 ENDED (Redis First) - 비딩 차단 최우선
      const stoppedCount = await this.stopExpiredCampaigns(cachedCampaigns);

      // 2. 예산 소진 캠페인 PAUSED (Redis → DB)
      const pausedCount = await this.pauseOverspentCampaigns(cachedCampaigns);

      // 3. ClickLog 기반 Spent 정산 (ClickLog → DB → Redis) - 배치 처리
      // 자정 정산이므로 '어제' 데이터 기준
      const yesterday = new Date();
      yesterday.setDate(yesterday.getDate() - 1);
      const reconciledCount = await this.reconcileSpentFromClickLog(yesterday);

      // 4. 일일 예산 리셋 (DB → Redis) - 0으로 초기화
      await this.resetDailyBudgets(cachedCampaigns);

      // 5. 시작일 된 캠페인 ACTIVE (DB First)
      const startedCount = await this.startScheduledCampaigns();

      // 6. 고아 이미지 정리 (프로덕션만)
      const orphanImagesDeleted = await this.cleanupOrphanImages();

      this.logger.log(
        `===== 일일 정산 완료 ===== ` +
          `종료: ${stoppedCount}건, ` +
          `예산PAUSED: ${pausedCount}건, ` +
          `정산보정: ${reconciledCount}건, ` +
          `시작: ${startedCount}건,` +
          `고아이미지: ${orphanImagesDeleted}건`
      );
    } catch (error) {
      this.logger.error('일일 정산 중 오류 발생', error);
      throw error;
    }
    this.logger.log(`총 소요 시간: ${Date.now() - startTime}ms`);
  }

  // ========================================
  // 시간별 정합성 체크 (매시 정각)
  // ========================================
  // @Cron('0 0 * * *', { timeZone: 'Asia/Seoul' })
  // 또는 특정 시간 (예: 1:25 AM)
  // @Cron('25 1 * * *')
  @Cron('0 * * * *')
  async hourlyReconciliation(): Promise<void> {
    this.logger.log('시간별 정합성 체크 시작');
    await this.reconcileSpentFromClickLog(new Date());
  }

  // ========================================
  // 전체 기간 마이그레이션 (수동 실행용) -> 일회용!
  // ========================================
  async migrateAllSpentFromClickLog(): Promise<number> {
    this.logger.log('[Migration] 전체 기간 Spent 마이그레이션 시작');
    const startTime = Date.now();

    // 전체 기간 totalSpent 집계
    const totalAggregation =
      await this.logRepository.aggregateTotalClicksByCampaign();

    this.logger.log(
      `[Migration] 전체 캠페인 집계: ${totalAggregation.length}건, 배치 크기: ${this.BATCH_SIZE}`
    );

    let migratedCount = 0;

    for (let i = 0; i < totalAggregation.length; i += this.BATCH_SIZE) {
      const batch = totalAggregation.slice(i, i + this.BATCH_SIZE);
      const campaignIds = batch.map((b) => b.campaignId);

      // Batch Lock
      const originalStatuses = new Map<string, string>();
      await Promise.all(
        campaignIds.map(async (id) => {
          const cached =
            await this.campaignCacheRepository.findCampaignCacheById(id);
          if (cached?.status === 'ACTIVE') {
            originalStatuses.set(id, 'ACTIVE');
            await this.campaignCacheRepository.updateCampaignStatus(
              id,
              CampaignStatus.PAUSED
            );
          }
        })
      );

      // 마이그레이션 수행
      await Promise.all(
        batch.map(async (total) => {
          const { campaignId, totalCost: actualTotalSpent } = total;

          // 오늘 날짜 기준 dailySpent도 계산
          const dailyAggregation =
            await this.logRepository.aggregateClicksByDate(new Date());
          const dailyData = dailyAggregation.find(
            (d) => d.campaignId === campaignId
          );
          const actualDailySpent = dailyData?.totalCost || 0;

          const cached =
            await this.campaignCacheRepository.findCampaignCacheById(
              campaignId
            );

          // DB 업데이트 (무조건 실행)
          await this.campaignRepository.updateSpent(
            campaignId,
            actualDailySpent,
            actualTotalSpent
          );

          // Redis 업데이트
          if (cached) {
            await this.campaignCacheRepository.replaceSpentCacheById(
              campaignId,
              actualDailySpent,
              actualTotalSpent
            );
          }

          migratedCount++;
          this.logger.debug(
            `[Migration] campaign=${campaignId}, dailySpent=${actualDailySpent}, totalSpent=${actualTotalSpent}`
          );
        })
      );

      // Batch Unlock
      await Promise.all(
        campaignIds.map(async (id) => {
          if (originalStatuses.get(id) === 'ACTIVE') {
            const cached =
              await this.campaignCacheRepository.findCampaignCacheById(id);
            if (cached) {
              await this.campaignCacheRepository.updateCampaignStatus(
                id,
                CampaignStatus.ACTIVE
              );
            }
          }
        })
      );

      await new Promise((resolve) => setTimeout(resolve, 100));
    }

    const duration = Date.now() - startTime;
    this.logger.log(
      `[Migration] 전체 기간 마이그레이션 완료: ${migratedCount}개 (${duration}ms)`
    );
    return migratedCount;
  }

  // ========================================
  // 수동 트리거 (API용)
  // ========================================
  async manualReset(): Promise<{
    statusUpdate: { started: number; stopped: number; paused: number };
    dailyBudgetReset: boolean;
    orphanImagesDeleted: number;
  }> {
    this.logger.log('수동 Lazy Reset 시작');
    const cachedCampaigns = await this.campaignCacheRepository.getAllCampaigns({
      allowStale: false,
    });

    const stopped = await this.stopExpiredCampaigns(cachedCampaigns);
    const paused = await this.pauseOverspentCampaigns(cachedCampaigns);
    const started = await this.startScheduledCampaigns();
    await this.resetDailyBudgets(cachedCampaigns);
    const orphanImagesDeleted = await this.cleanupOrphanImages();

    this.logger.log('수동 Lazy Reset 완료');

    return {
      statusUpdate: { started, stopped, paused },
      dailyBudgetReset: true,
      orphanImagesDeleted,
    };
  }

  // ========================================
  // Private: 개별 작업 메서드
  // ========================================

  //종료일 지난 캠페인 ENDED (Redis First - 비딩 차단)
  private async stopExpiredCampaigns(
    cachedCampaigns: CachedCampaign[]
  ): Promise<number> {
    this.logger.log(
      `[Step 1] 만료 캠페인 종료 처리 시작 (대상: ${cachedCampaigns.length}개)`
    ); // 추가
    const now = new Date();
    let stoppedCount = 0;

    for (const campaign of cachedCampaigns) {
      if (campaign.status === 'ENDED') continue;

      const endDate = new Date(campaign.endDate);
      if (now >= endDate) {
        // Redis 먼저 업데이트 (비딩 차단)
        await this.syncCacheStatus(campaign.id, CampaignStatus.ENDED);
        // DB 업데이트
        await this.campaignRepository.updateStatus(
          campaign.id,
          CampaignStatus.ENDED
        );
        stoppedCount++;
        this.logger.log(`캠페인 ${campaign.id} 종료 -> ENDED (날짜 만료)`);
      }
    }
    this.logger.log(`[Step 1] 만료 캠페인 종료 완료: ${stoppedCount}개`);
    return stoppedCount;
  }

  // 예산 소진 캠페인 PAUSED (Redis First)
  private async pauseOverspentCampaigns(
    cachedCampaigns: CachedCampaign[]
  ): Promise<number> {
    this.logger.log(`[Step 2] 예산 소진 캠페인 PAUSED 처리 시작`);
    let pausedCount = 0;

    for (const cached of cachedCampaigns) {
      if (cached.deletedAt || cached.status !== 'ACTIVE') continue;

      const isDailyExhausted = cached.dailySpent >= cached.dailyBudget;
      const isTotalExhausted =
        cached.totalBudget !== null && cached.totalSpent >= cached.totalBudget;

      if (isDailyExhausted || isTotalExhausted) {
        await this.syncCacheStatus(cached.id, CampaignStatus.PAUSED);
        await this.campaignRepository.updateStatus(
          cached.id,
          CampaignStatus.PAUSED
        );
        pausedCount++;
        this.logger.log(`캠페인 ${cached.id} 예산 소진 -> PAUSED`);
      }
    }
    this.logger.log(`[Step 2] 예산 소진 PAUSED 완료: ${pausedCount}개`);
    return pausedCount;
  }

  // 시작일 된 캠페인 ACTIVE (DB First - PENDING은 Redis에 없을 수 있음)
  private async startScheduledCampaigns(): Promise<number> {
    this.logger.log(`[Step 5] 시작 예정 캠페인 ACTIVE 처리 시작`);
    const now = new Date();
    // PENDING 캠페인은 Redis에 캐시 안 되어있을 수 있으므로 DB 조회
    const allCampaigns = await this.campaignRepository.getAll();
    this.logger.log(
      `[Step 5] DB 캠페인 ${allCampaigns.length}개 조회 (PENDING 필터링 예정)`
    );
    let startedCount = 0;

    for (const campaign of allCampaigns) {
      if (campaign.deletedAt || campaign.status !== 'PENDING') continue;

      const startDate = new Date(campaign.startDate);
      const endDate = new Date(campaign.endDate);

      if (now >= startDate && now < endDate) {
        // DB First (영구 저장 우선)
        await this.campaignRepository.updateStatus(
          campaign.id,
          CampaignStatus.ACTIVE
        );
        // Redis 동기화 (비딩 참여)
        await this.syncCacheStatus(campaign.id, CampaignStatus.ACTIVE);
        startedCount++;
        this.logger.log(`캠페인 ${campaign.id} 시작 (PENDING -> ACTIVE)`);
      }
    }
    return startedCount;
  }

  // 일일 예산 리셋
  private async resetDailyBudgets(
    cachedCampaigns: CachedCampaign[]
  ): Promise<void> {
    this.logger.log('일일 예산 리셋 시작');

    // 1. DB 전체 리셋 (단일 쿼리)
    await this.campaignRepository.resetAllDailySpent();

    // 2. Redis 배치 리셋 (윈도우 분리 적용)
    const activeCampaigns = cachedCampaigns.filter(
      (c) => c.status === 'ACTIVE' || c.status === 'PAUSED'
    );

    let syncCount = 0;

    for (let i = 0; i < activeCampaigns.length; i += this.BATCH_SIZE) {
      const batch = activeCampaigns.slice(i, i + this.BATCH_SIZE);
      this.logger.log(
        `[Step 4] 배치 ${Math.floor(i / this.BATCH_SIZE) + 1}: ${batch.length}개 리셋 중`
      );
      const campaignIds = batch.map((c) => c.id);

      // Batch Lock: ACTIVE -> PAUSED (리셋 중 비딩 차단)
      const originalStatuses = new Map<string, string>();

      await Promise.all(
        campaignIds.map(async (id) => {
          const cached = batch.find((c) => c.id === id);
          if (cached?.status === 'ACTIVE') {
            originalStatuses.set(id, 'ACTIVE');
            await this.campaignCacheRepository.updateCampaignStatus(
              id,
              CampaignStatus.PAUSED
            );
          }
        })
      );

      // 리셋 수행
      await Promise.all(
        campaignIds.map(async (id) => {
          try {
            await this.campaignCacheRepository.resetDailySpentCache(id);
            syncCount++;
          } catch (error) {
            this.logger.warn(`캠페인 ${id} 일일 예산 리셋 실패`, error);
          }
        })
      );

      // Batch Unlock: 원래 상태 복구
      await Promise.all(
        campaignIds.map(async (id) => {
          if (originalStatuses.get(id) === 'ACTIVE') {
            await this.campaignCacheRepository.updateCampaignStatus(
              id,
              CampaignStatus.ACTIVE
            );
          }
        })
      );

      // 배치 간 지연
      await new Promise((resolve) => setTimeout(resolve, 100));
    }

    this.logger.log(`일일 예산 리셋 완료 (Redis ${syncCount}건 동기화)`);
  }

  // ClickLog 기반 Spent 정산
  private async reconcileSpentFromClickLog(targetDate: Date): Promise<number> {
    this.logger.log(
      `[Step 3] ClickLog 정산 시작 (${targetDate.toLocaleDateString('ko-KR', { timeZone: 'Asia/Seoul' })})`
    );

    const dailyAggregation =
      await this.logRepository.aggregateClicksByDate(targetDate);
    const totalAggregation =
      await this.logRepository.aggregateTotalClicksByCampaign();
    const totalSpentMap = new Map(
      totalAggregation.map((a) => [a.campaignId, a.totalCost])
    );
    this.logger.log(
      `[Step 3] 일일 집계: ${dailyAggregation.length}건, 배치 크기: ${this.BATCH_SIZE}`
    );

    let reconciledCount = 0;

    for (let i = 0; i < dailyAggregation.length; i += this.BATCH_SIZE) {
      const batch = dailyAggregation.slice(i, i + this.BATCH_SIZE);
      const campaignIds = batch.map((b) => b.campaignId);

      // Batch Lock
      const originalStatuses = new Map<string, string>();
      await Promise.all(
        campaignIds.map(async (id) => {
          const cached =
            await this.campaignCacheRepository.findCampaignCacheById(id);
          if (cached?.status === 'ACTIVE') {
            originalStatuses.set(id, 'ACTIVE');
            await this.campaignCacheRepository.updateCampaignStatus(
              id,
              CampaignStatus.PAUSED
            );
          }
        })
      );

      // 정산 수행
      await Promise.all(
        batch.map(async (daily) => {
          const { campaignId, totalCost: actualDailySpent } = daily;
          const actualTotalSpent = totalSpentMap.get(campaignId) || 0;
          const cached =
            await this.campaignCacheRepository.findCampaignCacheById(
              campaignId
            );

          const needsReconcile =
            !cached ||
            cached.dailySpent !== actualDailySpent ||
            Math.abs(cached.totalSpent - actualTotalSpent) > 100; // 1~2 클릭 차이로 생긴 오차 보정

          if (needsReconcile) {
            await this.campaignRepository.updateSpent(
              campaignId,
              actualDailySpent,
              actualTotalSpent
            );
            if (cached) {
              await this.campaignCacheRepository.replaceSpentCacheById(
                campaignId,
                actualDailySpent,
                actualTotalSpent
              );
              reconciledCount++;
            }
          }
        })
      );

      // Batch Unlock
      await Promise.all(
        campaignIds.map(async (id) => {
          if (originalStatuses.get(id) === 'ACTIVE') {
            const cached =
              await this.campaignCacheRepository.findCampaignCacheById(id);
            if (cached) {
              await this.campaignCacheRepository.updateCampaignStatus(
                id,
                CampaignStatus.ACTIVE
              );
            }
          }
        })
      );

      await new Promise((resolve) => setTimeout(resolve, 100));
    }

    this.logger.log(`ClickLog 정산 완료: ${reconciledCount}개 보정`);
    return reconciledCount;
  }

  // 고아 이미지 정리용이나 개발환경에서는 스킵
  private async cleanupOrphanImages(): Promise<number> {
    if (!this.isProduction) {
      this.logger.log('개발 환경 - 고아 이미지 정리 스킵');
      return 0;
    }

    this.logger.log('고아 이미지 정리 시작');

    try {
      const storedImages = await this.imageService.listImages('campaigns/');
      const allCampaigns = await this.campaignRepository.getAll();
      const usedImageUrls = new Set(
        allCampaigns.filter((c) => c.image).map((c) => c.image)
      );

      let deletedCount = 0;
      for (const image of storedImages) {
        if (!usedImageUrls.has(image.url)) {
          try {
            await this.imageService.deleteImage(image.url);
            deletedCount++;
            this.logger.log(`고아 이미지 삭제: ${image.key}`);
          } catch (error) {
            this.logger.error(`이미지 삭제 실패: ${image.key}`, error);
          }
        }
      }

      this.logger.log(`고아 이미지 정리 완료: ${deletedCount}개 삭제`);
      return deletedCount;
    } catch (error) {
      this.logger.error('고아 이미지 정리 오류', error);
      return 0;
    }
  }

  // 캐시 상태 동기화 - Q: 이게 왜 필요할까
  private async syncCacheStatus(
    campaignId: string,
    newStatus: CampaignStatus
  ): Promise<void> {
    try {
      await this.campaignCacheRepository.updateCampaignStatus(
        campaignId,
        newStatus
      );
    } catch (error) {
      this.logger.warn(`캠페인 ${campaignId} Redis 상태 동기화 실패`, error);
    }
  }

  // ========================================
  // Legacy Methods (호환성 유지)
  // ========================================

  // 기존 updateCampaignStatuses 대체 (사용 안 함 권장)
  // async updateCampaignStatuses() {
  //   const stopped = await this.stopExpiredCampaigns();
  //   const started = await this.startScheduledCampaigns();
  //   return {
  //     pendingToActive: started,
  //     activeToEnded: stopped,
  //     pausedToEnded: 0, // stopExpiredCampaigns에서 처리됨
  //   };
  // }
}
