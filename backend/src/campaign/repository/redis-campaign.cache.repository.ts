import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { IOREDIS_CLIENT } from 'src/redis/redis.constant';
import type { AppIORedisClient } from 'src/redis/redis.type';
import {
  CampaignCacheRepository,
  CampaignCacheSaveOptions,
} from './campaign.cache.repository.interface';
import {
  AuctionReservationRecord,
  AuctionTransitionResult,
  BudgetReservationCandidate,
  BudgetReservationResult,
  CachedCampaign,
  CachedCampaignWithoutSpent,
  CampaignDocumentVectorSearchHit,
  CampaignEmbeddingPayload,
  CampaignTagVectorSearchHit,
  CampaignTagVectorSearchOptions,
  ReserveAuctionRequest,
  ReserveAuctionResult,
} from '../types/campaign.types';
import {
  REDIS_COMMIT_AUCTION_SCRIPT,
  REDIS_DECREMENT_SPENT_SCRIPT,
  REDIS_INCREMENT_SPENT_SCRIPT,
  REDIS_RELEASE_AUCTION_SCRIPT,
  REDIS_REPLACE_SPENT_SCRIPT,
  REDIS_RESET_DAILY_BUDGET_SCRIPT,
  REDIS_RESERVE_AUCTION_SCRIPT,
  REDIS_RESERVE_FIRST_AVAILABLE_SCRIPT,
  REDIS_SAVE_CAMPAIGN_PRESERVING_RESERVED_SCRIPT,
} from '../scripts/lua-script';
import {
  AUCTION_KEY_PREFIX,
  AUCTION_RESERVATION_EXPIRATIONS,
} from '../constants/auction-reservation.constants';
import {
  createRtbPathLogger,
  rtbPathLogsEnabled,
} from '../../common/logging/rtb-path-logger.util';
import {
  CAMPAIGN_CACHE_REMOVED_EVENT,
  CAMPAIGN_CACHE_UPSERTED_EVENT,
} from '../events/campaign-cache.events';
import {
  resolveEmbeddingProfile,
  toEmbeddingNamespace,
  type EmbeddingProfile,
} from '../../rtb/ml/embedding-profile';

@Injectable()
export class RedisCampaignCacheRepository implements CampaignCacheRepository {
  private readonly logger = createRtbPathLogger(
    RedisCampaignCacheRepository.name
  );
  private readonly logsEnabled = rtbPathLogsEnabled();
  private readonly KEY_PREFIX = 'campaign:';
  private readonly CAMPAIGN_KEYS_SET = 'campaign:keys';
  private readonly embeddingProfile: EmbeddingProfile;
  private readonly embeddingNamespace: string;
  private readonly campaignTagVectorPrefix: string;
  private readonly campaignTagVectorIndex: string;
  private readonly campaignTagVectorKeysPrefix: string;
  private readonly campaignDocumentVectorPrefix: string;
  private readonly campaignDocumentVectorIndex: string;
  private readonly CAMPAIGN_CACHE_TTL = 60 * 60 * 24;
  private readonly ALL_CAMPAIGNS_CACHE_TTL_MS = 10_000; // RTB decision hot path (짧은 TTL로 Redis SCAN/JSON.GET 비용 완화)
  private readonly ALL_CAMPAIGNS_CACHE_TTL_JITTER_RATIO = 0.2; // multi-instance stampede 완화 (±20%)
  private readonly ALL_CAMPAIGNS_CACHE_SWR_MS = 3_000; // stale-while-revalidate window
  private readonly embeddingDimension: number;
  private readonly hnswGraphDegree: number;
  private readonly hnswEfConstruction: number;

  private allCampaignsCache: {
    value: CachedCampaign[];
    freshUntilMs: number;
    staleUntilMs: number;
  } | null = null;

  private allCampaignsInFlight: Promise<CachedCampaign[]> | null = null;
  private campaignTagVectorIndexReady: Promise<void> | null = null;
  private campaignDocumentVectorIndexReady: Promise<void> | null = null;

  constructor(
    @Inject(IOREDIS_CLIENT) private readonly ioredisClient: AppIORedisClient,
    private readonly configService: ConfigService,
    private readonly eventEmitter: EventEmitter2
  ) {
    this.embeddingProfile = resolveEmbeddingProfile(
      this.configService.get<string>('RTB_EMBEDDING_PROFILE')
    );
    this.embeddingNamespace = toEmbeddingNamespace(
      this.embeddingProfile.modelVersion
    );
    // legacy profile은 기존 index를 그대로 사용해 rollback 비용을 없앤다.
    const legacy = this.embeddingProfile.name === 'legacy_minilm';
    this.campaignTagVectorPrefix = legacy
      ? 'campaign-tag-vec:'
      : `campaign-tag-vec:${this.embeddingNamespace}:`;
    this.campaignTagVectorIndex = legacy
      ? 'idx:campaign_tag_vec'
      : `idx:campaign_tag_vec:${this.embeddingNamespace}`;
    this.campaignTagVectorKeysPrefix = legacy
      ? 'campaign-tag-vec-keys:'
      : `campaign-tag-vec-keys:${this.embeddingNamespace}:`;
    this.campaignDocumentVectorPrefix = `campaign-doc-vec:${this.embeddingNamespace}:`;
    this.campaignDocumentVectorIndex = `idx:campaign_doc_vec:${this.embeddingNamespace}`;
    this.embeddingDimension = this.embeddingProfile.dimension;
    this.hnswGraphDegree = this.getPositiveIntEnv('RTB_MATCHER_ANN_HNSW_M', 16);
    this.hnswEfConstruction = this.getPositiveIntEnv(
      'RTB_MATCHER_ANN_HNSW_EF_CONSTRUCTION',
      200
    );
  }

  async saveCampaignCacheById(
    id: string,
    data: CachedCampaign,
    ttl = this.CAMPAIGN_CACHE_TTL,
    options: CampaignCacheSaveOptions = {}
  ): Promise<void> {
    const key = this.getCampaignCacheKey(id);
    const normalized = this.withReservationDefaults(data);

    try {
      if (options.preserveReservation === false) {
        await this.ioredisClient.call(
          'JSON.SET',
          key,
          '$',
          JSON.stringify(normalized)
        );
      } else {
        await this.ioredisClient.eval(
          REDIS_SAVE_CAMPAIGN_PRESERVING_RESERVED_SCRIPT,
          1,
          key,
          JSON.stringify(normalized),
          this.getKstBudgetDate(Date.now())
        );
      }
      await Promise.all([
        this.ioredisClient.expire(key, ttl), // Key에 TTL을 설정하는 명령 expire
        this.ioredisClient.sadd(this.CAMPAIGN_KEYS_SET, key),
      ]);
      await this.syncCampaignTagVectorDocs(normalized);
      await this.syncCampaignDocumentVectorDoc(normalized);
      this.publishUpsert(normalized);
    } catch (error) {
      this.logger.error(`캐시 저장 실패: ${id}`, error);
      throw error;
    }
  }

  async findCampaignCacheById(id: string): Promise<CachedCampaign | null> {
    const key = this.getCampaignCacheKey(id);

    try {
      const result = await this.ioredisClient.call('JSON.GET', key);

      if (!result || typeof result !== 'string') {
        this.logger.debug(`캐시 미스: ${id}`);
        return null;
      }

      return JSON.parse(result) as CachedCampaign;
    } catch (error) {
      this.logger.error(`캐시 조회 실패: ${id}`, error);
      return null;
    }
  }

  async findCampaignCachesByIds(ids: string[]): Promise<CachedCampaign[]> {
    const uniqueIds = [...new Set(ids.filter(Boolean))];
    if (uniqueIds.length === 0) {
      return [];
    }

    try {
      const pipeline = this.ioredisClient.pipeline();
      const keys = uniqueIds.map((id) => this.getCampaignCacheKey(id));

      keys.forEach((key) => {
        pipeline.call('JSON.GET', key);
      });

      const results = await pipeline.exec();
      if (!results) {
        return [];
      }

      const campaigns: CachedCampaign[] = [];
      results.forEach(([error, result], idx) => {
        if (error) {
          this.logger.warn(`캠페인 배치 조회 실패: ${keys[idx]}`, error);
          return;
        }

        if (typeof result !== 'string') {
          return;
        }

        try {
          campaigns.push(JSON.parse(result) as CachedCampaign);
        } catch (parseError) {
          this.logger.warn(`캠페인 JSON 파싱 실패: ${keys[idx]}`, parseError);
        }
      });

      return campaigns;
    } catch (error) {
      this.logger.error('캠페인 배치 조회 실패', error);
      return [];
    }
  }

  // 동시성 이슈가 있을 수 있는 Spent를 제외한 나머지 필드 업데이트
  async updateCampaignWithoutCachedById(
    id: string,
    data: CachedCampaignWithoutSpent
  ): Promise<void> {
    const key = this.getCampaignCacheKey(id);

    try {
      const updatePromises = Object.entries(data).map(([field, value]) =>
        this.ioredisClient.call(
          'JSON.SET',
          key,
          `$.${field}`,
          JSON.stringify(value)
        )
      );

      await Promise.all(updatePromises);
      const updatedCampaign = await this.findCampaignCacheById(id);
      if (updatedCampaign) {
        await this.syncCampaignTagVectorDocs(updatedCampaign);
        await this.syncCampaignDocumentVectorDoc(updatedCampaign);
        this.publishUpsert(updatedCampaign);
      }
    } catch (error) {
      this.logger.error(`캐시 저장 실패: ${id}`, error);
      throw error;
    }
  }

  // 상태만 업데이트
  async updateCampaignStatus(id: string, status: string): Promise<void> {
    const key = this.getCampaignCacheKey(id);

    try {
      await this.ioredisClient.call(
        'JSON.SET',
        key,
        '$.status',
        JSON.stringify(status)
      );
      const updatedCampaign = await this.findCampaignCacheById(id);
      if (updatedCampaign) {
        await this.syncCampaignTagVectorDocs(updatedCampaign);
        await this.syncCampaignDocumentVectorDoc(updatedCampaign);
        this.publishUpsert(updatedCampaign);
      }
    } catch (error) {
      this.logger.error(`캠페인 상태 업데이트 실패: ${id}`, error);
      throw error;
    }
  }

  // 태그 변경 시 임베딩 비우기
  async deleteCampaignEmbeddingById(id: string): Promise<void> {
    const key = this.getCampaignCacheKey(id);
    try {
      await this.ioredisClient.call(
        'JSON.SET',
        key,
        '$.embeddingTags',
        JSON.stringify({})
      );
      await Promise.all([
        this.ioredisClient.call(
          'JSON.SET',
          key,
          '$.embeddingDocument',
          JSON.stringify(null)
        ),
        this.ioredisClient.call(
          'JSON.SET',
          key,
          '$.embeddingModelVersion',
          JSON.stringify(null)
        ),
        this.deleteCampaignTagVectorDocs(id),
        this.deleteCampaignDocumentVectorDoc(id),
      ]);
      const updatedCampaign = await this.findCampaignCacheById(id);
      if (updatedCampaign) {
        this.publishUpsert(updatedCampaign);
      }
    } catch (error) {
      this.logger.error(`임베딩 삭제 실패: ${id}`, error);
      throw error;
    }
  }

  async updateDailySpentCacheById(id: string, amount: number): Promise<void> {
    const key = this.getCampaignCacheKey(id);

    try {
      await this.ioredisClient.call(
        'JSON.NUMINCRBY', // Redis에게 ADD에 대한 명령을 통한 원자적 연산 수행
        key,
        '$.dailySpent',
        amount.toString()
      );
    } catch (error) {
      this.logger.error(`dailySpent 업데이트 실패: ${id}`, error);
      throw error;
    }
  }

  async replaceSpentCacheById(
    id: string,
    dailySpent: number,
    totalSpent: number
  ): Promise<void> {
    const key = this.getCampaignCacheKey(id);

    try {
      const replaced = Number(
        await this.ioredisClient.eval(
          REDIS_REPLACE_SPENT_SCRIPT,
          1,
          key,
          String(dailySpent),
          String(totalSpent)
        )
      );
      if (replaced !== 1) {
        this.logger.warn(`spent 교체 대상 캠페인 캐시 없음: ${id}`);
      }
    } catch (error) {
      this.logger.error(`spent 교체 실패: ${id}`, error);
      throw error;
    }
  }

  async resetDailySpentCache(id: string): Promise<void> {
    const key = this.getCampaignCacheKey(id);
    const now = new Date();

    try {
      await this.ioredisClient.eval(
        REDIS_RESET_DAILY_BUDGET_SCRIPT,
        1,
        key,
        this.getKstBudgetDate(now.getTime()),
        now.toISOString()
      );
    } catch (error) {
      this.logger.error(`일일 예산 리셋 실패: ${id}`, error);
      throw error;
    }
  }

  async incrementSpent(campaignId: string, cpc: number): Promise<boolean> {
    const key = this.getCampaignCacheKey(campaignId);

    try {
      // lua 스크립트로 트랜잭션 처리
      const result = (await this.ioredisClient.eval(
        REDIS_INCREMENT_SPENT_SCRIPT,
        1,
        key,
        cpc.toString()
      )) as number;

      if (result === 1) {
        if (this.logsEnabled) {
          this.logger.debug(
            `캠페인 ${campaignId} Spent 증가 성공: +${cpc} (일일/총)`
          );
        }
        return true;
      }

      if (result === 0) {
        if (this.logsEnabled) {
          this.logger.debug(`캠페인 ${campaignId} 일일 예산 초과로 증가 실패`);
        }
      } else if (result === -1) {
        if (this.logsEnabled) {
          this.logger.debug(`캠페인 ${campaignId} 총 예산 초과로 증가 실패`);
        }
      } else if (result === -2) {
        if (this.logsEnabled) {
          this.logger.debug(`캠페인 ${campaignId} 비활성 상태로 증가 실패`);
        }
      } else {
        if (this.logsEnabled) {
          this.logger.warn(
            `캠페인 ${campaignId} 캐시 없음 (result: ${result})`
          );
        }
      }

      return false;
    } catch (error) {
      this.logger.error(`캠페인 ${campaignId} Spent 증가 실패`, error);
      return false;
    }
  }

  /**
   * 순위가 확정된 후보를 앞에서부터 검사해 예산 확보가 가능한 첫 캠페인 하나를 예약한다.
   * Lua 스크립트에서 예산 검증과 spent 증가를 원자적으로 처리하며, 예약할 후보가 없으면 null을 반환한다.
   */
  async reserveFirstAvailable(
    candidates: BudgetReservationCandidate[]
  ): Promise<BudgetReservationResult | null> {
    if (candidates.length === 0) {
      return null;
    }

    const keys = candidates.map((candidate) =>
      this.getCampaignCacheKey(candidate.campaignId)
    );
    const cpcs = candidates.map((candidate) => String(candidate.cpc));

    try {
      const result = (await this.ioredisClient.eval(
        REDIS_RESERVE_FIRST_AVAILABLE_SCRIPT,
        keys.length,
        ...keys,
        ...cpcs
      )) as [number, number];
      const selectedIndex = Number(result?.[0] ?? 0);
      const attemptedCount = Number(result?.[1] ?? candidates.length);

      if (selectedIndex <= 0 || selectedIndex > candidates.length) {
        return null;
      }

      return {
        campaignId: candidates[selectedIndex - 1].campaignId,
        attemptedCount,
      };
    } catch (error) {
      this.logger.error('순위 window winner-only 예약 실패', error);
      return null;
    }
  }

  async reserveAuction(
    request: ReserveAuctionRequest
  ): Promise<ReserveAuctionResult> {
    if (request.candidates.length === 0) {
      return { outcome: 'exhausted', attemptedCount: 0 };
    }

    const auctionKey = this.getAuctionKey(request.auctionId);
    const campaignKeys = request.candidates.map((candidate) =>
      this.getCampaignCacheKey(candidate.campaignId)
    );
    const cpcs = request.candidates.map((candidate) => String(candidate.cpc));
    const campaignIds = request.candidates.map(
      (candidate) => candidate.campaignId
    );

    try {
      const raw = (await this.ioredisClient.eval(
        REDIS_RESERVE_AUCTION_SCRIPT,
        campaignKeys.length + 2,
        AUCTION_RESERVATION_EXPIRATIONS,
        auctionKey,
        ...campaignKeys,
        request.auctionId,
        String(request.blogId),
        request.budgetDate,
        String(request.expiresAt),
        String(this.CAMPAIGN_CACHE_TTL),
        ...cpcs,
        ...campaignIds
      )) as unknown[];
      const code = Number(raw?.[0]);
      const attemptedCount = Number(raw?.[2] ?? request.candidates.length);
      const reservation = this.parseAuctionReservation(raw?.[3]);

      if (code === 1) {
        return {
          outcome: 'reserved',
          reservation: reservation ?? undefined,
          attemptedCount,
        };
      }
      if (code === 2) {
        return {
          outcome: 'existing',
          reservation: reservation ?? undefined,
          attemptedCount,
        };
      }
      if (code === -2) {
        return { outcome: 'conflict', attemptedCount };
      }
      return { outcome: 'exhausted', attemptedCount };
    } catch (error) {
      this.logger.error(`경매 예약 생성 실패: ${request.auctionId}`, error);
      throw error;
    }
  }

  async getAuctionReservation(
    auctionId: string
  ): Promise<AuctionReservationRecord | null> {
    const raw = await this.ioredisClient.get(this.getAuctionKey(auctionId));
    return this.parseAuctionReservation(raw);
  }

  async commitAuction(
    auctionId: string,
    currentBudgetDate: string,
    terminalTtlSeconds: number
  ): Promise<AuctionTransitionResult> {
    const current = await this.getAuctionReservation(auctionId);
    if (!current) {
      await this.ioredisClient.zrem(
        AUCTION_RESERVATION_EXPIRATIONS,
        auctionId
      );
      return { outcome: 'not_found' };
    }
    if (current.status === 'COMMITTED') {
      return { outcome: 'already_committed', reservation: current };
    }
    if (current.status === 'RELEASED') {
      return { outcome: 'already_released', reservation: current };
    }
    if (!('campaignId' in current)) {
      return { outcome: 'invalid', reservation: current };
    }

    const raw = (await this.ioredisClient.eval(
      REDIS_COMMIT_AUCTION_SCRIPT,
      3,
      this.getAuctionKey(auctionId),
      AUCTION_RESERVATION_EXPIRATIONS,
      this.getCampaignCacheKey(current.campaignId),
      auctionId,
      currentBudgetDate,
      String(terminalTtlSeconds),
      String(Date.now())
    )) as unknown[];
    return this.toTransitionResult(Number(raw?.[0]), raw?.[1], 'commit');
  }

  async releaseAuction(
    auctionId: string,
    terminalTtlSeconds: number
  ): Promise<AuctionTransitionResult> {
    const current = await this.getAuctionReservation(auctionId);
    if (!current) {
      await this.ioredisClient.zrem(
        AUCTION_RESERVATION_EXPIRATIONS,
        auctionId
      );
      return { outcome: 'not_found' };
    }
    if (current.status === 'COMMITTED') {
      return { outcome: 'already_committed', reservation: current };
    }
    if (current.status === 'RELEASED') {
      return { outcome: 'already_released', reservation: current };
    }
    if (!('campaignId' in current)) {
      return { outcome: 'invalid', reservation: current };
    }

    const raw = (await this.ioredisClient.eval(
      REDIS_RELEASE_AUCTION_SCRIPT,
      3,
      this.getAuctionKey(auctionId),
      AUCTION_RESERVATION_EXPIRATIONS,
      this.getCampaignCacheKey(current.campaignId),
      auctionId,
      String(terminalTtlSeconds),
      String(Date.now())
    )) as unknown[];
    return this.toTransitionResult(Number(raw?.[0]), raw?.[1], 'release');
  }

  async findExpiredAuctionIds(
    nowEpochMs: number,
    limit: number
  ): Promise<string[]> {
    if (limit <= 0) return [];
    return this.ioredisClient.zrangebyscore(
      AUCTION_RESERVATION_EXPIRATIONS,
      '-inf',
      String(nowEpochMs),
      'LIMIT',
      0,
      Math.floor(limit)
    );
  }

  async decrementSpent(campaignId: string, cpc: number): Promise<void> {
    const key = this.getCampaignCacheKey(campaignId);

    try {
      const result = (await this.ioredisClient.eval(
        REDIS_DECREMENT_SPENT_SCRIPT,
        1,
        key,
        cpc.toString() // 양수로 전달 (Lua에서 -cpc 처리)
      )) as number;

      if (result === 1) {
        if (this.logsEnabled) {
          this.logger.debug(
            `캠페인 ${campaignId} Spent 롤백 완료: -${cpc} (일일/총)`
          );
        }
      } else if (result === 0) {
        if (this.logsEnabled) {
          this.logger.warn(
            `캠페인 ${campaignId} 일일 Spent 음수 방지 (현재값 < ${cpc})`
          );
        }
      } else if (result === -1) {
        if (this.logsEnabled) {
          this.logger.warn(
            `캠페인 ${campaignId} 총 Spent 음수 방지 (현재값 < ${cpc})`
          );
        }
      } else if (result === -99) {
        if (this.logsEnabled) {
          this.logger.error(`캠페인 ${campaignId} 캐시 없음 (롤백 실패)`);
        }
      }
    } catch (error) {
      this.logger.error(`캠페인 ${campaignId} Spent 롤백 실패`, error);
      // 롤백 실패는 치명적이지 않음 (과다 차감 방향은 안전)
      // 일일 정산에서 보정됨
    }
  }

  async deleteCampaignCacheById(id: string): Promise<void> {
    const key = this.getCampaignCacheKey(id);
    await Promise.all([
      this.ioredisClient.del(key),
      this.ioredisClient.srem(this.CAMPAIGN_KEYS_SET, key),
      this.deleteCampaignTagVectorDocs(id),
      this.deleteCampaignDocumentVectorDoc(id),
    ]);
    this.allCampaignsCache = null;
    this.eventEmitter.emit(CAMPAIGN_CACHE_REMOVED_EVENT, { campaignId: id });
    this.logger.debug(`캐시 삭제: ${id}`);
  }

  async existsCampaignCacheById(id: string): Promise<boolean> {
    const key = this.getCampaignCacheKey(id);
    const result = await this.ioredisClient.exists(key);
    return result === 1;
  }

  async updateCampaignEmbeddingTags(
    id: string,
    embeddingTags: { [tagName: string]: number[] }
  ): Promise<void> {
    const key = this.getCampaignCacheKey(id);

    try {
      await Promise.all([
        this.ioredisClient.call(
          'JSON.SET',
          key,
          '$.embeddingTags',
          JSON.stringify(embeddingTags)
        ),
        this.ioredisClient.call(
          'JSON.SET',
          key,
          '$.embeddingModelVersion',
          JSON.stringify(this.embeddingProfile.modelVersion)
        ),
      ]);
      const campaign = await this.findCampaignCacheById(id);
      if (campaign) {
        await this.syncCampaignTagVectorDocs(campaign);
        this.publishUpsert(campaign);
      }
    } catch (error) {
      this.logger.error(`캠페인 임베딩 업데이트 실패: ${id}`, error);
      throw error;
    }
  }

  async updateCampaignEmbeddings(
    id: string,
    payload: CampaignEmbeddingPayload
  ): Promise<void> {
    if (payload.modelVersion !== this.embeddingProfile.modelVersion) {
      throw new Error(
        `campaign embedding model version 불일치: ${payload.modelVersion} vs ${this.embeddingProfile.modelVersion}`
      );
    }
    this.assertEmbeddingDimension(payload.document, 'campaign document');
    for (const [tagName, embedding] of Object.entries(payload.tags)) {
      this.assertEmbeddingDimension(embedding, `campaign tag ${tagName}`);
    }

    const key = this.getCampaignCacheKey(id);
    try {
      const pipeline = this.ioredisClient.pipeline();
      pipeline.call(
        'JSON.SET',
        key,
        '$.embeddingModelVersion',
        JSON.stringify(payload.modelVersion)
      );
      pipeline.call(
        'JSON.SET',
        key,
        '$.embeddingDocument',
        JSON.stringify(payload.document)
      );
      pipeline.call(
        'JSON.SET',
        key,
        '$.embeddingTags',
        JSON.stringify(payload.tags)
      );
      await pipeline.exec();

      const campaign = await this.findCampaignCacheById(id);
      if (campaign) {
        await Promise.all([
          this.syncCampaignTagVectorDocs(campaign),
          this.syncCampaignDocumentVectorDoc(campaign),
        ]);
        this.publishUpsert(campaign);
      }
    } catch (error) {
      this.logger.error(`캠페인 semantic 임베딩 업데이트 실패: ${id}`, error);
      throw error;
    }
  }

  async searchCampaignTagVectors(
    options: CampaignTagVectorSearchOptions
  ): Promise<CampaignTagVectorSearchHit[]> {
    const topL = Math.max(1, Math.floor(options.topL));
    await this.ensureCampaignTagVectorIndex();

    const vectorQuery = this.encodeFloat32Buffer(options.queryEmbedding);
    const highIntentTag = options.isHighIntent ? '1' : '0';
    const nowTs = Math.floor(options.nowTs);
    const query =
      `(@status:{ACTIVE} @isHighIntent:{${highIntentTag}} ` +
      `@startTs:[-inf ${nowTs}] @endTs:[(${nowTs} +inf])` +
      `=>[KNN ${topL} @embedding $query_vec AS vector_distance]`;

    try {
      const raw = await this.ioredisClient.call(
        'FT.SEARCH',
        this.campaignTagVectorIndex,
        query,
        'PARAMS',
        '2',
        'query_vec',
        vectorQuery,
        'SORTBY',
        'vector_distance',
        'ASC',
        'RETURN',
        '3',
        'campaignId',
        'tagName',
        'vector_distance',
        'LIMIT',
        '0',
        String(topL),
        'DIALECT',
        '2'
      );

      return this.parseCampaignTagVectorSearchResults(raw);
    } catch (error) {
      this.logger.error('campaign-tag ANN 검색 실패', error);
      return [];
    }
  }

  async searchCampaignDocumentVectors(
    options: CampaignTagVectorSearchOptions
  ): Promise<CampaignDocumentVectorSearchHit[]> {
    const topL = Math.max(1, Math.floor(options.topL));
    await this.ensureCampaignDocumentVectorIndex();

    const vectorQuery = this.encodeFloat32Buffer(options.queryEmbedding);
    const highIntentTag = options.isHighIntent ? '1' : '0';
    const nowTs = Math.floor(options.nowTs);
    const query =
      `(@status:{ACTIVE} @isHighIntent:{${highIntentTag}} ` +
      `@startTs:[-inf ${nowTs}] @endTs:[(${nowTs} +inf])` +
      `=>[KNN ${topL} @embedding $query_vec AS vector_distance]`;

    try {
      const raw = await this.ioredisClient.call(
        'FT.SEARCH',
        this.campaignDocumentVectorIndex,
        query,
        'PARAMS',
        '2',
        'query_vec',
        vectorQuery,
        'SORTBY',
        'vector_distance',
        'ASC',
        'RETURN',
        '2',
        'campaignId',
        'vector_distance',
        'LIMIT',
        '0',
        String(topL),
        'DIALECT',
        '2'
      );
      return this.parseCampaignDocumentVectorSearchResults(raw);
    } catch (error) {
      this.logger.error('campaign-document ANN 검색 실패', error);
      return [];
    }
  }

  private publishUpsert(campaign: CachedCampaign): void {
    this.allCampaignsCache = null;
    this.eventEmitter.emit(CAMPAIGN_CACHE_UPSERTED_EVENT, { campaign });
  }

  /**
   * Redis에서 전체 캠페인 조회
   */
  async getAllCampaigns(options?: {
    allowStale?: boolean;
  }): Promise<CachedCampaign[]> {
    const nowMs = Date.now();
    const allowStale = options?.allowStale ?? true;

    const cached = this.allCampaignsCache;
    if (cached && cached.freshUntilMs > nowMs) {
      return cached.value;
    }

    // 현재 반환대기중인 Promise가 없으면 백그라운드 refresh 요청하고 stale값 반환
    if (allowStale && cached && cached.staleUntilMs > nowMs) {
      if (!this.allCampaignsInFlight) {
        void this.refreshAllCampaignsCache().catch(() => {
          // refresh 내부에서 로깅하므로 여기서는 noop
        });
      }
      return cached.value;
    }

    // 반환대기중인 Promise가 있으면 해당 Promise를 반환받음
    if (this.allCampaignsInFlight) {
      return this.allCampaignsInFlight;
    }

    // 요청과 요청사이의 간격이 갈어져서 nowMs가 staleTTL마저도 지나게되면 동기로 갱신
    return this.refreshAllCampaignsCache();
  }

  private getCampaignCacheKey(id: string): string {
    return `${this.KEY_PREFIX}${id}`;
  }

  private getAuctionKey(auctionId: string): string {
    return `${AUCTION_KEY_PREFIX}${auctionId}`;
  }

  private parseAuctionReservation(
    raw: unknown
  ): AuctionReservationRecord | null {
    if (typeof raw !== 'string' || raw.length === 0) return null;
    try {
      const parsed = JSON.parse(raw) as Partial<AuctionReservationRecord>;
      if (parsed.version !== 1 || typeof parsed.auctionId !== 'string') {
        return null;
      }
      if (
        parsed.status !== 'RESERVED' &&
        parsed.status !== 'COMMITTED' &&
        parsed.status !== 'RELEASED'
      ) {
        return null;
      }
      if (parsed.status === 'RESERVED') {
        if (
          typeof parsed.campaignId !== 'string' ||
          typeof parsed.blogId !== 'number' ||
          typeof parsed.cost !== 'number' ||
          typeof parsed.budgetDate !== 'string' ||
          typeof parsed.expiresAt !== 'number'
        ) {
          return null;
        }
      }
      return parsed as AuctionReservationRecord;
    } catch {
      return null;
    }
  }

  private toTransitionResult(
    code: number,
    rawReservation: unknown,
    operation: 'commit' | 'release'
  ): AuctionTransitionResult {
    const reservation = this.parseAuctionReservation(rawReservation) ??
      undefined;
    if (code === 1) {
      return {
        outcome: operation === 'commit' ? 'committed' : 'released',
        reservation,
      };
    }
    if (code === 2) {
      return {
        outcome:
          operation === 'commit' ? 'already_committed' : 'already_released',
        reservation,
      };
    }
    if (code === -1) {
      return {
        outcome:
          operation === 'commit' ? 'already_released' : 'already_committed',
        reservation,
      };
    }
    if (code === -2) return { outcome: 'expired', reservation };
    if (code === -3) return { outcome: 'released', reservation };
    if (code === -99) return { outcome: 'not_found' };
    return { outcome: 'invalid', reservation };
  }

  private withReservationDefaults(data: CachedCampaign): CachedCampaign {
    return {
      ...data,
      dailyReserved: data.dailyReserved ?? 0,
      totalReserved: data.totalReserved ?? 0,
      dailyReservedDate:
        data.dailyReservedDate ?? this.getKstBudgetDate(Date.now()),
    };
  }

  private getKstBudgetDate(epochMs: number): string {
    return new Date(epochMs + 9 * 60 * 60 * 1000)
      .toISOString()
      .slice(0, 10);
  }

  private getCampaignTagVectorDocKey(
    campaignId: string,
    tagName: string
  ): string {
    return `${this.campaignTagVectorPrefix}${campaignId}:${encodeURIComponent(tagName)}`;
  }

  private getCampaignTagVectorKeysSet(campaignId: string): string {
    return `${this.campaignTagVectorKeysPrefix}${campaignId}`;
  }

  private getCampaignDocumentVectorDocKey(campaignId: string): string {
    return `${this.campaignDocumentVectorPrefix}${campaignId}`;
  }

  private getPositiveIntEnv(name: string, defaultValue: number): number {
    const raw = this.configService.get<string>(name);
    const parsed = raw ? Number.parseInt(raw, 10) : defaultValue;
    if (!Number.isFinite(parsed) || parsed <= 0) {
      return defaultValue;
    }
    return parsed;
  }

  private encodeFloat32Buffer(values: number[]): Buffer {
    const floatArray = new Float32Array(values);
    return Buffer.from(floatArray.buffer);
  }

  private assertEmbeddingDimension(values: number[], label: string): void {
    if (values.length !== this.embeddingDimension) {
      throw new Error(
        `${label} embedding 차원 불일치: ${values.length} vs ${this.embeddingDimension}`
      );
    }
  }

  private async ensureCampaignTagVectorIndex(): Promise<void> {
    if (this.campaignTagVectorIndexReady) {
      return this.campaignTagVectorIndexReady;
    }

    this.campaignTagVectorIndexReady = (async () => {
      try {
        await this.ioredisClient.call('FT.INFO', this.campaignTagVectorIndex);
        return;
      } catch {
        // index가 없으면 아래에서 생성
      }

      try {
        await this.ioredisClient.call(
          'FT.CREATE',
          this.campaignTagVectorIndex,
          'ON',
          'HASH',
          'PREFIX',
          '1',
          this.campaignTagVectorPrefix,
          'SCHEMA',
          'campaignId',
          'TAG',
          'tagName',
          'TAG',
          'status',
          'TAG',
          'isHighIntent',
          'TAG',
          'startTs',
          'NUMERIC',
          'endTs',
          'NUMERIC',
          'embedding',
          'VECTOR',
          'HNSW',
          '10',
          'TYPE',
          'FLOAT32',
          'DIM',
          String(this.embeddingDimension),
          'DISTANCE_METRIC',
          'COSINE',
          'M',
          String(this.hnswGraphDegree),
          'EF_CONSTRUCTION',
          String(this.hnswEfConstruction)
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (!message.includes('Index already exists')) {
          throw error;
        }
      }
    })().catch((error) => {
      this.campaignTagVectorIndexReady = null;
      throw error;
    });

    return this.campaignTagVectorIndexReady;
  }

  private async ensureCampaignDocumentVectorIndex(): Promise<void> {
    if (this.campaignDocumentVectorIndexReady) {
      return this.campaignDocumentVectorIndexReady;
    }

    this.campaignDocumentVectorIndexReady = this.ensureVectorIndex(
      this.campaignDocumentVectorIndex,
      this.campaignDocumentVectorPrefix
    ).catch((error) => {
      this.campaignDocumentVectorIndexReady = null;
      throw error;
    });
    return this.campaignDocumentVectorIndexReady;
  }

  private async ensureVectorIndex(
    indexName: string,
    prefix: string
  ): Promise<void> {
    try {
      await this.ioredisClient.call('FT.INFO', indexName);
      return;
    } catch {
      // index가 없으면 아래에서 생성
    }
    try {
      await this.ioredisClient.call(
        'FT.CREATE',
        indexName,
        'ON',
        'HASH',
        'PREFIX',
        '1',
        prefix,
        'SCHEMA',
        'campaignId',
        'TAG',
        'status',
        'TAG',
        'isHighIntent',
        'TAG',
        'startTs',
        'NUMERIC',
        'endTs',
        'NUMERIC',
        'embedding',
        'VECTOR',
        'HNSW',
        '10',
        'TYPE',
        'FLOAT32',
        'DIM',
        String(this.embeddingDimension),
        'DISTANCE_METRIC',
        'COSINE',
        'M',
        String(this.hnswGraphDegree),
        'EF_CONSTRUCTION',
        String(this.hnswEfConstruction)
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!message.includes('Index already exists')) {
        throw error;
      }
    }
  }

  private async syncCampaignTagVectorDocs(
    campaign: CachedCampaign
  ): Promise<void> {
    const compatible =
      campaign.embeddingModelVersion === this.embeddingProfile.modelVersion ||
      (this.embeddingProfile.name === 'legacy_minilm' &&
        !campaign.embeddingModelVersion);
    if (
      !compatible ||
      !campaign.tags ||
      campaign.tags.length === 0 ||
      !campaign.embeddingTags ||
      Object.keys(campaign.embeddingTags).length === 0
    ) {
      await this.deleteCampaignTagVectorDocs(campaign.id);
      return;
    }

    await this.ensureCampaignTagVectorIndex();
    await this.deleteCampaignTagVectorDocs(campaign.id);

    const startTs = new Date(campaign.startDate).getTime();
    const endTs = new Date(campaign.endDate).getTime();
    const vectorKeysSet = this.getCampaignTagVectorKeysSet(campaign.id);
    const pipeline = this.ioredisClient.pipeline();
    const activeTagKeys: string[] = [];

    for (const tagName of campaign.tags) {
      const embedding = campaign.embeddingTags[tagName];
      if (!embedding || embedding.length !== this.embeddingDimension) {
        continue;
      }

      const docKey = this.getCampaignTagVectorDocKey(campaign.id, tagName);
      activeTagKeys.push(docKey);
      pipeline.call(
        'HSET',
        docKey,
        'campaignId',
        campaign.id,
        'tagName',
        tagName,
        'status',
        campaign.status,
        'isHighIntent',
        campaign.isHighIntent ? '1' : '0',
        'startTs',
        String(startTs),
        'endTs',
        String(endTs),
        'embedding',
        this.encodeFloat32Buffer(embedding)
      );
    }

    if (activeTagKeys.length === 0) {
      await pipeline.exec();
      await this.deleteCampaignTagVectorDocs(campaign.id);
      return;
    }

    pipeline.sadd(vectorKeysSet, ...activeTagKeys);
    await pipeline.exec();
  }

  private async syncCampaignDocumentVectorDoc(
    campaign: CachedCampaign
  ): Promise<void> {
    const embedding = campaign.embeddingDocument;
    const compatible =
      campaign.embeddingModelVersion === this.embeddingProfile.modelVersion;
    if (
      !compatible ||
      !embedding ||
      embedding.length !== this.embeddingDimension
    ) {
      await this.deleteCampaignDocumentVectorDoc(campaign.id);
      return;
    }

    await this.ensureCampaignDocumentVectorIndex();
    const key = this.getCampaignDocumentVectorDocKey(campaign.id);
    await this.ioredisClient.call(
      'HSET',
      key,
      'campaignId',
      campaign.id,
      'status',
      campaign.status,
      'isHighIntent',
      campaign.isHighIntent ? '1' : '0',
      'startTs',
      String(new Date(campaign.startDate).getTime()),
      'endTs',
      String(new Date(campaign.endDate).getTime()),
      'embedding',
      this.encodeFloat32Buffer(embedding)
    );
  }

  private async deleteCampaignDocumentVectorDoc(
    campaignId: string
  ): Promise<void> {
    await this.ioredisClient.del(
      this.getCampaignDocumentVectorDocKey(campaignId)
    );
  }

  private async deleteCampaignTagVectorDocs(campaignId: string): Promise<void> {
    const vectorKeysSet = this.getCampaignTagVectorKeysSet(campaignId);
    const keys = await this.ioredisClient.smembers(vectorKeysSet);
    const pipeline = this.ioredisClient.pipeline();

    if (keys.length > 0) {
      pipeline.del(...keys);
    }
    pipeline.del(vectorKeysSet);
    await pipeline.exec();
  }

  private parseCampaignTagVectorSearchResults(
    raw: unknown
  ): CampaignTagVectorSearchHit[] {
    if (!Array.isArray(raw) || raw.length === 0) {
      return [];
    }

    const entries: unknown[] = raw;
    const hits: CampaignTagVectorSearchHit[] = [];
    for (let i = 1; i < entries.length; i += 2) {
      const fields = entries[i + 1];
      if (!Array.isArray(fields)) {
        continue;
      }

      const fieldEntries: unknown[] = fields;
      const fieldMap = new Map<string, string>();
      for (let j = 0; j < fieldEntries.length; j += 2) {
        const key = fieldEntries[j];
        const value = fieldEntries[j + 1];
        if (typeof key !== 'string') {
          continue;
        }
        fieldMap.set(key, typeof value === 'string' ? value : String(value));
      }

      const campaignId = fieldMap.get('campaignId');
      const tagName = fieldMap.get('tagName');
      const distanceRaw = fieldMap.get('vector_distance');

      if (!campaignId || !tagName || distanceRaw === undefined) {
        continue;
      }

      const distance = Number.parseFloat(distanceRaw);
      if (!Number.isFinite(distance)) {
        continue;
      }

      hits.push({
        campaignId,
        tagName,
        distance,
        similarity: Math.max(0, 1 - distance),
      });
    }

    return hits;
  }

  private parseCampaignDocumentVectorSearchResults(
    raw: unknown
  ): CampaignDocumentVectorSearchHit[] {
    if (!Array.isArray(raw) || raw.length === 0) {
      return [];
    }

    const hits: CampaignDocumentVectorSearchHit[] = [];
    for (let i = 1; i < raw.length; i += 2) {
      const fields = raw[i + 1];
      if (!Array.isArray(fields)) continue;
      const fieldMap = new Map<string, string>();
      for (let j = 0; j < fields.length; j += 2) {
        const key = fields[j];
        const value = fields[j + 1];
        if (typeof key === 'string') {
          fieldMap.set(key, typeof value === 'string' ? value : String(value));
        }
      }
      const campaignId = fieldMap.get('campaignId');
      const distance = Number.parseFloat(
        fieldMap.get('vector_distance') ?? 'NaN'
      );
      if (!campaignId || !Number.isFinite(distance)) continue;
      hits.push({
        campaignId,
        distance,
        similarity: Math.max(0, 1 - distance),
      });
    }
    return hits;
  }

  private computeJitteredTtlMs(baseTtlMs: number): number {
    const ratio = Math.max(0, this.ALL_CAMPAIGNS_CACHE_TTL_JITTER_RATIO);
    if (ratio === 0) return baseTtlMs;

    const min = Math.floor(baseTtlMs * (1 - ratio));
    const max = Math.ceil(baseTtlMs * (1 + ratio));
    const clampedMin = Math.max(0, min);
    const clampedMax = Math.max(clampedMin, max);
    return (
      clampedMin + Math.floor(Math.random() * (clampedMax - clampedMin + 1))
    );
  }

  private async refreshAllCampaignsCache(): Promise<CachedCampaign[]> {
    if (this.allCampaignsInFlight) {
      return this.allCampaignsInFlight;
    }
    // stale값을 fallback용으로 설정
    const previous = this.allCampaignsCache;

    const work = (async () => {
      try {
        // SCAN은 Redis 전체 keyspace를 순회하므로(매칭 키가 적어도) key가 많은 환경에서 매우 느림
        // 캠페인 키 인덱스(Set)를 사용해 O(#campaign) 조회로 변경. (인덱스가 비어있으면 SCAN으로 backfill)
        let keys = await this.ioredisClient.smembers(this.CAMPAIGN_KEYS_SET);
        keys = keys.filter((k) => k.startsWith(this.KEY_PREFIX));

        // 키 인덱스가 없으면 SCAN으로 전수조사
        if (keys.length === 0) {
          const pattern = `${this.KEY_PREFIX}*`;
          const scannedKeys: string[] = [];

          // 캠페인 Key 인덱스가 없으면 SCAN으로 모든 campaign:* 키 조회 후 인덱스에 등록
          let cursor = '0';
          do {
            const result = await this.ioredisClient.scan(
              cursor,
              'MATCH',
              pattern,
              'COUNT',
              100
            );
            cursor = result[0];
            scannedKeys.push(...result[1]);
          } while (cursor !== '0');

          keys = scannedKeys;

          if (keys.length > 0) {
            const BATCH_SIZE = 500;
            for (let i = 0; i < keys.length; i += BATCH_SIZE) {
              const batch = keys.slice(i, i + BATCH_SIZE);
              await this.ioredisClient.sadd(this.CAMPAIGN_KEYS_SET, ...batch);
            }
          }
        }

        if (keys.length === 0) {
          return [];
        }

        // JSON.GET는 다건 호출 시 latency가 커져 in-flight 요청이 쌓이며 heap spike로 이어질 수 있음
        // → pipeline + batch로 라운드트립을 줄입니다.
        const campaigns: CachedCampaign[] = [];
        const staleKeys: string[] = [];
        const BATCH_SIZE = 200;

        for (let i = 0; i < keys.length; i += BATCH_SIZE) {
          const batchKeys = keys.slice(i, i + BATCH_SIZE);
          const pipeline = this.ioredisClient.pipeline();

          batchKeys.forEach((key) => {
            pipeline.call('JSON.GET', key);
          });

          const results = await pipeline.exec();
          if (!results) continue;

          results.forEach(([error, result], idx) => {
            if (error) {
              this.logger.warn(`캠페인 조회 실패: ${batchKeys[idx]}`, error);
              return;
            }

            if (result && typeof result === 'string') {
              try {
                campaigns.push(JSON.parse(result) as CachedCampaign);
              } catch (parseError) {
                this.logger.warn(
                  `캠페인 JSON 파싱 실패: ${batchKeys[idx]}`,
                  parseError
                );
              }
              return;
            }

            // 키는 인덱스에 있지만 값이 없으면(만료/삭제) stale로 간주합니다.
            staleKeys.push(batchKeys[idx]);
          });
        }

        if (staleKeys.length > 0) {
          const BATCH_SIZE = 500;
          for (let i = 0; i < staleKeys.length; i += BATCH_SIZE) {
            const batch = staleKeys.slice(i, i + BATCH_SIZE);
            await this.ioredisClient.srem(this.CAMPAIGN_KEYS_SET, ...batch);
          }
        }

        return campaigns;
      } catch (error) {
        this.logger.error('모든 캠페인 조회 실패', error);
        if (previous) return previous.value;
        return [];
      } finally {
        this.allCampaignsInFlight = null;
      }
    })();

    this.allCampaignsInFlight = work;
    const campaigns = await work;

    const ttlMs = this.computeJitteredTtlMs(this.ALL_CAMPAIGNS_CACHE_TTL_MS);
    const freshUntilMs = Date.now() + ttlMs;
    const staleUntilMs = freshUntilMs + this.ALL_CAMPAIGNS_CACHE_SWR_MS;
    this.allCampaignsCache = { value: campaigns, freshUntilMs, staleUntilMs };

    return campaigns;
  }
}
