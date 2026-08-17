import {
  Inject,
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import Redis from 'ioredis';
import { IOREDIS_CLIENT } from 'src/redis/redis.constant';
import type { AppIORedisClient } from 'src/redis/redis.type';
import { CacheRepository } from '../cache/repository/cache.repository.interface';
import { CampaignCacheRepository } from 'src/campaign/repository/campaign.cache.repository.interface';
import { ConfigService } from '@nestjs/config';
import { AUCTION_TERMINAL_TTL_SECONDS } from 'src/campaign/constants/auction-reservation.constants';

// TTL 만료 이벤트를 감지하여 롤백을 수행하는 Worker
@Injectable()
export class RedisTTLWorker implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(RedisTTLWorker.name);
  private subscriber: Redis | null = null;
  private reservationSweepTimer: NodeJS.Timeout | null = null;
  private reservationSweepRunning = false;
  private readonly reservationSweepIntervalMs: number;
  private readonly reservationSweepBatchSize: number;
  private readonly reservationSweepTimeBudgetMs: number;
  private readonly reservationSweepMaxBatches: number;
  private readonly auctionTerminalTtlSeconds: number;

  constructor(
    @Inject(IOREDIS_CLIENT) private readonly ioRedisClient: AppIORedisClient,
    private readonly cacheRepository: CacheRepository,
    private readonly campaignCacheRepository: CampaignCacheRepository,
    private readonly configService: ConfigService
  ) {
    this.reservationSweepIntervalMs = this.getPositiveIntConfig(
      'RTB_RESERVATION_SWEEP_INTERVAL_MS',
      1_000
    );
    this.reservationSweepBatchSize = this.getPositiveIntConfig(
      'RTB_RESERVATION_SWEEP_BATCH_SIZE',
      100
    );
    this.reservationSweepTimeBudgetMs = this.getPositiveIntConfig(
      'RTB_RESERVATION_SWEEP_TIME_BUDGET_MS',
      200
    );
    this.reservationSweepMaxBatches = this.getPositiveIntConfig(
      'RTB_RESERVATION_SWEEP_MAX_BATCHES',
      10
    );
    this.auctionTerminalTtlSeconds = this.getPositiveIntConfig(
      'RTB_AUCTION_TERMINAL_TTL_SECONDS',
      AUCTION_TERMINAL_TTL_SECONDS
    );
  }

  async onModuleInit() {
    this.startReservationSweep();
    try {
      // Keyspace Notification 활성화
      await this.ioRedisClient.config('SET', 'notify-keyspace-events', 'Ex');
      this.logger.log(
        'Redis Keyspace Notification 설정 완료: notify-keyspace-events Ex'
      );

      // 별도 subscriber 연결 (pub/sub용)
      this.subscriber = this.ioRedisClient.duplicate();
      await this.subscriber.subscribe('__keyevent@0__:expired'); // Redis TTL이 만료되었을때의 자동으로 발생하는 만료이벤트를 구독함

      this.subscriber.on('message', (channel, expiredKey) => {
        // async 핸들러를 void로 래핑 (lint 에러 방지)
        void this.handleExpiredKey(expiredKey);
      });

      this.logger.log('TTL Worker 시작 - Keyspace Notification 구독 중');
    } catch (error) {
      this.logger.error('TTL Worker 초기화 실패', error);
      // 초기화 실패해도 앱 구동은 계속 (graceful degradation)
    }
  }

  async onModuleDestroy() {
    if (this.reservationSweepTimer) {
      clearInterval(this.reservationSweepTimer);
      this.reservationSweepTimer = null;
    }
    if (this.subscriber) {
      await this.subscriber.unsubscribe('__keyevent@0__:expired');
      this.subscriber.disconnect();
      this.logger.log('TTL Worker 종료 - Keyspace Notification 구독 해제');
      // TODO: 이 부분이 무작정 해제되도 Redis >= DB의 단방향 불일치는 유지되는가?
    }
  }

  // TTL 만료된 키 처리
  private async handleExpiredKey(expiredKey: string): Promise<void> {
    // rollback:view:{viewId} 형태인지 확인
    const match = expiredKey.match(/^rollback:view:(\d+)$/);
    if (!match) return;

    const viewId = parseInt(match[1], 10);

    try {
      // 백업 정보 조회
      const backup = await this.cacheRepository.getRollbackBackup(viewId);
      if (!backup) {
        this.logger.debug(
          `[TTL Worker] viewId=${viewId}: 백업 없음 (이미 처리됨 - 클릭 또는 Dismiss)`
        );
        return;
      }

      const { campaignId, cost, createdAt } = backup;
      const elapsedMs = Date.now() - new Date(createdAt).getTime();

      // 롤백 수행
      await this.campaignCacheRepository.decrementSpent(campaignId, cost);

      // 백업 삭제
      await this.cacheRepository.deleteRollbackBackup(viewId);

      this.logger.warn(
        `[TTL Worker] 롤백 완료: viewId=${viewId}, campaign=${campaignId}, cost=-${cost}, elapsed=${Math.floor(elapsedMs / 1000)}s (Beacon 미수신으로 TTL 만료)`
      );
    } catch (error) {
      this.logger.error(`[TTL Worker] 롤백 실패: viewId=${viewId}`, error);
    }
  }

  private startReservationSweep(): void {
    void this.sweepExpiredReservations();
    this.reservationSweepTimer = setInterval(() => {
      void this.sweepExpiredReservations();
    }, this.reservationSweepIntervalMs);
    this.reservationSweepTimer.unref();
  }

  async sweepExpiredReservations(): Promise<void> {
    if (this.reservationSweepRunning) return;
    this.reservationSweepRunning = true;
    const deadline = Date.now() + this.reservationSweepTimeBudgetMs;

    try {
      for (
        let batch = 0;
        batch < this.reservationSweepMaxBatches && Date.now() <= deadline;
        batch += 1
      ) {
        const auctionIds =
          await this.campaignCacheRepository.findExpiredAuctionIds(
            Date.now(),
            this.reservationSweepBatchSize
          );
        if (auctionIds.length === 0) break;

        const results = await Promise.allSettled(
          auctionIds.map((auctionId) =>
            this.campaignCacheRepository.releaseAuction(
              auctionId,
              this.auctionTerminalTtlSeconds
            )
          )
        );
        results.forEach((result, index) => {
          if (result.status === 'rejected') {
            this.logger.error(
              `[Reservation Worker] 예약 해제 실패: auction=${auctionIds[index]}`,
              result.reason
            );
          }
        });

        if (auctionIds.length < this.reservationSweepBatchSize) break;
      }
    } catch (error) {
      this.logger.error('[Reservation Worker] expiration sweep 실패', error);
    } finally {
      this.reservationSweepRunning = false;
    }
  }

  private getPositiveIntConfig(name: string, fallback: number): number {
    const parsed = Number(this.configService.get<string>(name));
    return Number.isFinite(parsed) && parsed > 0
      ? Math.floor(parsed)
      : fallback;
  }
}
