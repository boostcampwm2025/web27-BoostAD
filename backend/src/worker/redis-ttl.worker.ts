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

// TTL 만료 이벤트를 감지하여 롤백을 수행하는 Worker
@Injectable()
export class RedisTTLWorker implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(RedisTTLWorker.name);
  private subscriber: Redis | null = null;

  constructor(
    @Inject(IOREDIS_CLIENT) private readonly ioRedisClient: AppIORedisClient,
    private readonly cacheRepository: CacheRepository,
    private readonly campaignCacheRepository: CampaignCacheRepository
  ) {}

  async onModuleInit() {
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
}
