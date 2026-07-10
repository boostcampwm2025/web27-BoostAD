import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Matcher } from './matcher.interface';
import { CampaignCacheRepository } from '../../campaign/repository/campaign.cache.repository.interface';
import {
  CampaignServingSnapshotService,
  type ServingCampaign,
} from '../../campaign/campaign-serving-snapshot.service';
import { MLEngine } from '../ml/mlEngine.interface';
import { RequestEmbeddingCacheService } from '../ml/request-embedding-cache.service';
import type { EmbeddingPendingReason } from '../ml/request-embedding-cache.service';
import { ContextEmbeddingService } from '../context/context-embedding.service';
import type { DecisionContext, ScoredCandidate } from '../types/decision.types';
import type { CachedCampaign } from '../../campaign/types/campaign.types';
import { MetricsService } from '../../metrics/metrics.service';
import {
  createRtbPathLogger,
  rtbPathLogsEnabled,
} from '../../common/logging/rtb-path-logger.util';

type MatchableCampaign = CachedCampaign | ServingCampaign;

@Injectable()
export class TransformerMatcher extends Matcher {
  private readonly logger = createRtbPathLogger(TransformerMatcher.name);
  private readonly logsEnabled = rtbPathLogsEnabled();
  private readonly CPC_WEIGHT = 0.3;
  private readonly SIMILARITY_WEIGHT = 0.7;

  // 최종 매칭 점수(0~1) 임계값
  private readonly SIMILARITY_THRESHOLD = 0.3;

  /**
   * 고도화된 스코어링(요청 텍스트 vs 캠페인 태그별 유사도 집계)
   *
   * - 기존: (캠페인 태그들을 join한 1문장) vs (요청 태그 join 1문장) 단일 비교
   * - 개선: 캠페인의 "각 태그"를 요청 텍스트와 각각 비교한 뒤, top-k + coverage + exact 보너스로 점수 산정
   *
   * 이유:
   * - 캠페인 태그가 많아질수록 join 문장은 노이즈가 섞여 유사도가 희석될 수 있음
   * - tag-wise 비교는 "정말 가까운 태그"가 점수에 더 직접 반영됨
   */
  private readonly TOP_K = 3;
  private readonly TOP_K_WEIGHTS = [0.5, 0.3, 0.2] as const;
  private readonly COVERAGE_THRESHOLD = 0.45;
  private readonly COVERAGE_SATURATION = 2; // 2개 이상 임계치 넘으면 coverage는 1로 포화
  private readonly FINAL_WEIGHTS = {
    top: 0.7,
    coverage: 0.25,
    exact: 0.05,
  } as const;

  private readonly annEnabled: boolean;
  private readonly annTopL: number;
  private readonly annTopM: number;
  private readonly annMaxTagHitsPerCampaign: number;
  private readonly localSnapshotEnabled: boolean;
  private readonly coldMissFastPathEnabled: boolean;
  private readonly lexicalTopM: number;
  private readonly contextDecisionEnabled: boolean;

  constructor(
    private readonly campaignCacheRepo: CampaignCacheRepository,
    private readonly campaignServingSnapshot: CampaignServingSnapshotService,
    private readonly mlEngine: MLEngine,
    private readonly requestEmbeddingCache: RequestEmbeddingCacheService,
    private readonly contextEmbeddingService: ContextEmbeddingService,
    private readonly metricsService: MetricsService,
    private readonly configService: ConfigService
  ) {
    super();
    this.annEnabled =
      this.configService.get<string>('RTB_MATCHER_ANN_ENABLED', 'false') ===
      'true';
    this.annTopL = this.getPositiveIntEnv('RTB_MATCHER_ANN_TOP_L', 200);
    this.annTopM = this.getPositiveIntEnv('RTB_MATCHER_ANN_TOP_M', 30);
    this.annMaxTagHitsPerCampaign = this.getPositiveIntEnv(
      'RTB_MATCHER_ANN_PER_CAMPAIGN_HIT_LIMIT',
      3
    );
    const campaignSource = this.configService.get<string>(
      'RTB_CAMPAIGN_SOURCE'
    );
    this.localSnapshotEnabled = campaignSource
      ? campaignSource === 'local_snapshot'
      : this.configService.get<string>(
          'RTB_MATCHER_LOCAL_SNAPSHOT_ENABLED',
          'false'
        ) === 'true';
    this.coldMissFastPathEnabled =
      this.localSnapshotEnabled &&
      this.configService.get<string>(
        'RTB_EMBEDDING_COLD_MISS_FAST_PATH_ENABLED',
        'false'
      ) === 'true';
    this.lexicalTopM = this.getPositiveIntEnv('RTB_LEXICAL_TOP_M', 30);
    this.contextDecisionEnabled =
      this.localSnapshotEnabled &&
      this.configService.get<string>(
        'RTB_CONTEXT_DECISION_ENABLED',
        'false'
      ) === 'true';
  }

  /**
   * 후보 캠페인 조회 (예산 검증 X).
   *
   * Phase 3 분기 요약:
   *  1) contextId + READY  → 글 embedding으로 ANN
   *  2) contextId + PENDING/FAILED → lexical fallback (기다리지 않음)
   *  3) contextId 없음 + cold-miss ON → tag L1/L2 hit면 ANN, miss면 lexical + background warm-up
   *  4) cold-miss OFF → 기존처럼 resolve()로 runtime까지 await
   */
  async findCandidatesByTags(
    context: DecisionContext
  ): Promise<ScoredCandidate[]> {
    const requestText = this.buildRequestText(context.tags);
    const requestNorm = this.normalizeText(requestText);
    const requestTokens = new Set(this.tokenizeText(requestText));

    if (!this.mlEngine.isReady()) {
      // 모델 로딩 전이라도 광고는 나가야 하면 태그 문자열 매칭으로 응답
      if (this.coldMissFastPathEnabled) {
        return this.findCandidatesByLexicalFallback(context, 'model_not_ready');
      }
      this.metricsService.incRtbFallback('matcher_empty');
      if (this.logsEnabled) {
        this.logger.warn('ML 모델이 준비가 안 되었습니다.');
      }
      return [];
    }

    let requestEmbedding: number[];
    const requestEmbeddingStartedAt = process.hrtime.bigint();
    try {
      // (1) SDK observe가 넘겨준 contextId 우선
      if (this.contextDecisionEnabled && context.contextId) {
        const contextResult =
          await this.contextEmbeddingService.resolveForDecision(
            context.contextId
          );
        this.metricsService.recordRtbContextDecision(contextResult.status);
        if (contextResult.status !== 'READY') {
          // 첫 방문 PENDING이 여기로 옴 → Xenova 대기 없이 lexical
          this.metricsService.recordRtbStage(
            'match_request_embedding',
            'fallback',
            this.elapsedMs(requestEmbeddingStartedAt)
          );
          return this.findCandidatesByLexicalFallback(
            context,
            `context_${contextResult.status.toLowerCase()}`
          );
        }
        requestEmbedding = contextResult.embedding;
        this.metricsService.incRtbEmbeddingSource('context');
      } else if (this.coldMissFastPathEnabled) {
        // (2) 태그 캐시만 조회. miss면 pending + 백그라운드 생성, 이번 요청은 lexical
        const resolved =
          await this.requestEmbeddingCache.resolveCachedOrSchedule(requestText);
        if (resolved.status === 'pending') {
          this.metricsService.recordRtbStage(
            'match_request_embedding',
            'fallback',
            this.elapsedMs(requestEmbeddingStartedAt)
          );
          return this.findCandidatesByLexicalFallback(context, resolved.reason);
        }
        requestEmbedding = resolved.embedding;
      } else {
        // (3) flag off: 캐시 miss여도 runtime까지 기다림 (구 Phase 3A 동기 경로)
        requestEmbedding = await this.getEmbeddingCached(requestText);
      }
      this.metricsService.recordRtbStage(
        'match_request_embedding',
        'ok',
        this.elapsedMs(requestEmbeddingStartedAt)
      );
    } catch (error) {
      if (this.coldMissFastPathEnabled) {
        this.metricsService.recordRtbStage(
          'match_request_embedding',
          'fallback',
          this.elapsedMs(requestEmbeddingStartedAt)
        );
        return this.findCandidatesByLexicalFallback(context, 'cache_error');
      }
      this.metricsService.recordRtbStage(
        'match_request_embedding',
        'error',
        this.elapsedMs(requestEmbeddingStartedAt)
      );
      this.metricsService.incRtbFallback('embedding_error');
      if (this.logsEnabled) {
        this.logger.warn(
          '요청 태그 임베딩 생성에 실패했습니다.',
          error as Error
        );
      }
      return [];
    }

    if (this.annEnabled) {
      return this.findCandidatesByAnn(
        context,
        requestEmbedding,
        requestNorm,
        requestTokens
      );
    }

    // Redis에서 모든 캠페인 조회 (캐시 우선 전략)
    const getAllCampaignsStartedAt = process.hrtime.bigint();
    const allCampaigns = await this.campaignCacheRepo.getAllCampaigns();
    this.metricsService.recordRtbStage(
      'match_get_all_campaigns',
      'ok',
      this.elapsedMs(getAllCampaignsStartedAt)
    );

    // 비딩 자격 필터링: ACTIVE + 날짜 범위 + deletedAt + embeddingTags + isHighIntent 존재
    const filterEligibleStartedAt = process.hrtime.bigint();
    const eligibleCampaigns = this.filterEligibleCampaigns(
      allCampaigns,
      context.isHighIntent
    );
    this.metricsService.recordRtbStage(
      'match_filter_eligible',
      'ok',
      this.elapsedMs(filterEligibleStartedAt)
    );
    this.metricsService.observeRtbEligibleCampaignCount(
      eligibleCampaigns.length
    );

    if (eligibleCampaigns.length === 0) {
      this.metricsService.incRtbFallback('matcher_empty');
      if (this.logsEnabled) {
        this.logger.debug('비딩 가능한 캠페인이 없습니다.');
      }
      return [];
    }

    return this.scoreEligibleCampaigns(
      eligibleCampaigns,
      requestEmbedding,
      requestNorm,
      requestTokens,
      allCampaigns.length
    );
  }

  /**
   * Transformer/ANN을 우회하는 태그 문자열 fast path.
   * local snapshot 역인덱스에서 태그 교집합 캠페인을 모아
   * exact match 수 → coverage → CPC 순으로 top-M을 고른다.
   */
  private async findCandidatesByLexicalFallback(
    context: DecisionContext,
    reason:
      | EmbeddingPendingReason
      | 'model_not_ready'
      | 'cache_error'
      | `context_${string}`
  ): Promise<ScoredCandidate[]> {
    const startedAt = process.hrtime.bigint();
    const requestTags = new Set(
      context.tags.map((tag) => this.normalizeText(tag)).filter(Boolean)
    );
    // Redis hydrate 없이 프로세스 로컬 역인덱스만 조회
    const indexedCampaigns =
      await this.campaignServingSnapshot.findCampaignsByTags([...requestTags]);
    const eligibleCampaigns = this.filterEligibleCampaigns(
      indexedCampaigns,
      context.isHighIntent,
      false
    );

    const candidates = eligibleCampaigns
      .map((campaign) => {
        const campaignTags = new Set(
          (campaign.tags ?? [])
            .map((tag) => this.normalizeText(tag))
            .filter(Boolean)
        );
        let exactMatchCount = 0;
        for (const tag of requestTags) {
          if (campaignTags.has(tag)) {
            exactMatchCount += 1;
          }
        }
        const coverage =
          requestTags.size === 0 ? 0 : exactMatchCount / requestTags.size;
        return {
          ...campaign,
          embeddingTags: undefined,
          similarity: coverage,
          score: exactMatchCount * 100 + coverage * 10,
          exactMatchCount,
        };
      })
      .filter((candidate) => candidate.exactMatchCount > 0)
      .sort((a, b) => {
        if (b.exactMatchCount !== a.exactMatchCount) {
          return b.exactMatchCount - a.exactMatchCount;
        }
        if (b.similarity !== a.similarity) {
          return b.similarity - a.similarity;
        }
        if (b.maxCpc !== a.maxCpc) {
          return b.maxCpc - a.maxCpc;
        }
        return a.id.localeCompare(b.id);
      })
      .slice(0, this.lexicalTopM)
      .map(({ exactMatchCount: _exactMatchCount, ...candidate }) => candidate);

    this.metricsService.incRtbEmbeddingSource('fallback');
    this.metricsService.recordRtbLexicalFallback(reason, candidates.length);
    this.metricsService.incRtbFallback(`embedding_${reason}`);
    this.metricsService.recordRtbStage(
      'match_lexical_fallback',
      candidates.length > 0 ? 'ok' : 'fallback',
      this.elapsedMs(startedAt)
    );
    this.metricsService.observeRtbEligibleCampaignCount(
      eligibleCampaigns.length
    );

    if (candidates.length === 0) {
      this.metricsService.incRtbFallback('matcher_empty');
    }
    return candidates;
  }

  private getPositiveIntEnv(name: string, defaultValue: number): number {
    const raw = this.configService.get<string>(name);
    const parsed = raw ? Number.parseInt(raw, 10) : defaultValue;
    if (!Number.isFinite(parsed) || parsed <= 0) {
      return defaultValue;
    }
    return parsed;
  }

  private async findCandidatesByAnn(
    context: DecisionContext,
    requestEmbedding: number[],
    requestNorm: string,
    requestTokens: Set<string>
  ): Promise<ScoredCandidate[]> {
    const annSearchStartedAt = process.hrtime.bigint();
    const tagHits = await this.campaignCacheRepo.searchCampaignTagVectors({
      queryEmbedding: requestEmbedding,
      topL: this.annTopL,
      isHighIntent: context.isHighIntent,
      nowTs: Date.now(),
    });
    this.metricsService.recordRtbStage(
      'match_ann_search',
      'ok',
      this.elapsedMs(annSearchStartedAt)
    );
    this.metricsService.observeRtbAnnTagHitCount(tagHits.length);

    if (tagHits.length === 0) {
      this.metricsService.incRtbFallback('matcher_empty');
      if (this.logsEnabled) {
        this.logger.debug('ANN retrieval 결과가 비어 있습니다.');
      }
      return [];
    }

    const groupHitsStartedAt = process.hrtime.bigint();
    const retrievedCampaignIds = this.aggregateAnnTagHits(tagHits)
      .slice(0, this.annTopM)
      .map((item) => item.campaignId);
    this.metricsService.recordRtbStage(
      'match_ann_group_hits',
      'ok',
      this.elapsedMs(groupHitsStartedAt)
    );
    this.metricsService.observeRtbAnnRetrievedCampaignCount(
      retrievedCampaignIds.length
    );

    if (retrievedCampaignIds.length === 0) {
      this.metricsService.incRtbFallback('matcher_empty');
      return [];
    }

    const loadRetrievedStartedAt = process.hrtime.bigint();
    const retrievedCampaigns = this.localSnapshotEnabled
      ? await this.campaignServingSnapshot.findCampaignsByIds(
          retrievedCampaignIds
        )
      : await this.campaignCacheRepo.findCampaignCachesByIds(
          retrievedCampaignIds
        );
    this.metricsService.recordRtbStage(
      this.localSnapshotEnabled
        ? 'match_campaign_hydrate_snapshot'
        : 'match_campaign_hydrate_redis',
      'ok',
      this.elapsedMs(loadRetrievedStartedAt)
    );

    const eligibleCampaigns = this.filterEligibleCampaigns(
      retrievedCampaigns,
      context.isHighIntent
    );

    if (eligibleCampaigns.length === 0) {
      this.metricsService.incRtbFallback('matcher_empty');
      return [];
    }

    return this.scoreEligibleCampaigns(
      eligibleCampaigns,
      requestEmbedding,
      requestNorm,
      requestTokens,
      eligibleCampaigns.length
    );
  }

  private aggregateAnnTagHits(
    tagHits: Array<{ campaignId: string; similarity: number }>
  ): Array<{ campaignId: string; retrievalScore: number }> {
    const grouped = new Map<string, number[]>();

    for (const hit of tagHits) {
      const bucket = grouped.get(hit.campaignId) ?? [];
      if (bucket.length < this.annMaxTagHitsPerCampaign) {
        bucket.push(hit.similarity);
      } else {
        const minValue = Math.min(...bucket);
        if (hit.similarity > minValue) {
          const minIndex = bucket.indexOf(minValue);
          bucket[minIndex] = hit.similarity;
        }
      }
      grouped.set(hit.campaignId, bucket);
    }

    return [...grouped.entries()]
      .map(([campaignId, similarities]) => {
        const sorted = [...similarities].sort((a, b) => b - a);
        const topWeighted = this.computeTopWeightedSimilarity(sorted);
        const coverage = this.clamp01(
          sorted.length / this.annMaxTagHitsPerCampaign
        );
        const retrievalScore = this.clamp01(
          topWeighted * 0.85 + coverage * 0.15
        );

        return { campaignId, retrievalScore };
      })
      .sort((a, b) => b.retrievalScore - a.retrievalScore);
  }

  private computeTopWeightedSimilarity(similarities: number[]): number {
    const k = Math.min(this.TOP_K, similarities.length);
    let weighted = 0;
    let weightSum = 0;

    for (let i = 0; i < k; i++) {
      const weight = this.TOP_K_WEIGHTS[i] ?? 0;
      weightSum += weight;
      weighted += similarities[i] * weight;
    }

    if (weightSum === 0) {
      return 0;
    }

    return this.clamp01(weighted / weightSum);
  }

  private async scoreEligibleCampaigns(
    eligibleCampaigns: MatchableCampaign[],
    requestEmbedding: number[],
    requestNorm: string,
    requestTokens: Set<string>,
    totalCampaignCount: number
  ): Promise<ScoredCandidate[]> {
    // 자격 있는 캠페인에 대해 유사도와 최종 점수를 한 번에 계산합니다.
    // - Promise.all(대량)로 한 번에 태스크를 쌓으면, 대규모 캠페인에서 메모리/마이크로태스크 오버헤드가 커질 수 있음
    // - 순차 계산 + 임계값 통과 케이스만 후보로 유지
    const scoreLoopStartedAt = process.hrtime.bigint();
    const candidates: ScoredCandidate[] = [];
    try {
      for (const campaign of eligibleCampaigns) {
        const similarity = await this.scoreCampaignByTags(
          requestEmbedding,
          requestNorm,
          requestTokens,
          campaign
        );
        if (similarity >= this.SIMILARITY_THRESHOLD) {
          candidates.push(this.buildCandidate(campaign, similarity));
        }
      }
      this.metricsService.recordRtbStage(
        'match_exact_rerank',
        'ok',
        this.elapsedMs(scoreLoopStartedAt)
      );
    } catch (error) {
      this.metricsService.recordRtbStage(
        'match_exact_rerank',
        'error',
        this.elapsedMs(scoreLoopStartedAt)
      );
      throw error;
    }

    if (this.logsEnabled) {
      this.logger.debug(
        `필터링된 캠페인 수 ${candidates.length}/${totalCampaignCount} 캠페인의 유사도 (임계값: ${this.SIMILARITY_THRESHOLD})`
      );
    }

    return candidates;
  }

  private buildCandidate(
    campaign: MatchableCampaign,
    similarity: number
  ): ScoredCandidate {
    const cpcScore = campaign.maxCpc * this.CPC_WEIGHT;
    const similarityScore = similarity * 100 * this.SIMILARITY_WEIGHT;

    return {
      ...campaign,
      embeddingTags: undefined,
      similarity,
      score: cpcScore + similarityScore,
    };
  }

  // 요청 태그 배열을 임베딩을 위한 단일 텍스트로 변환합니다.
  private buildRequestText(tags: string[]): string {
    const canonicalTags = [
      ...new Set(tags.map((tag) => this.normalizeText(tag)).filter(Boolean)),
    ].sort();

    return canonicalTags.join(' ');
  }

  // 비딩 자격 필터링: ACTIVE + 날짜 범위 + deletedAt + embeddingTags 존재
  private filterEligibleCampaigns(
    campaigns: MatchableCampaign[],
    isHighIntent: boolean,
    requireEmbeddings = true
  ): MatchableCampaign[] {
    const now = new Date();

    return campaigns.filter((campaign) => {
      // 삭제된 캠페인 제외
      if (campaign.deletedAt) {
        return false;
      }

      // ACTIVE 상태만 허용
      if (campaign.status !== 'ACTIVE') {
        return false;
      }

      // 날짜 범위 검증
      const startDate = new Date(campaign.startDate);
      const endDate = new Date(campaign.endDate);

      if (now < startDate || now >= endDate) {
        return false;
      }

      // embeddingTags 존재 여부 (임베딩 없으면 유사도 계산 불가)
      if (
        requireEmbeddings &&
        (!campaign.embeddingTags ||
          Object.keys(campaign.embeddingTags).length === 0)
      ) {
        return false;
      }

      // isHighIntert가 일치하는지 여부
      if (isHighIntent !== campaign.isHighIntent) {
        return false;
      }

      return true;
    });
  }

  private normalizeText(text: string): string {
    return text.normalize('NFC').toLowerCase().replace(/\s+/g, ' ').trim();
  }

  // 텍스트를 비교용 토큰으로 분해합니다 (camelCase/구분자 분리 + sql 접미어 분해).
  // 예) "mongoDb" -> ["mongo","db"], "postgresSql" -> ["postgres","sql"], "mysql" -> ["my","sql"]
  private tokenizeText(text: string): string[] {
    const normalized = this.normalizeText(
      text.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/[_\-/]+/g, ' ')
    );

    const tokens: string[] = [];
    for (const raw of normalized.split(' ')) {
      const t = raw.trim();
      if (!t) continue;

      if (t.length > 3 && t.endsWith('sql')) {
        const base = t.slice(0, -3);
        if (base) tokens.push(base);
        tokens.push('sql');
      } else {
        tokens.push(t);
      }
    }
    return tokens;
  }

  private hasTokenOverlap(a: Set<string>, b: Set<string>): boolean {
    for (const t of a) {
      if (b.has(t)) return true;
    }
    return false;
  }

  private clamp01(n: number): number {
    if (Number.isNaN(n)) return 0;
    return Math.max(0, Math.min(1, n));
  }

  private elapsedMs(startedAt: bigint): number {
    return Number(process.hrtime.bigint() - startedAt) / 1_000_000;
  }

  private async getEmbeddingCached(text: string): Promise<number[]> {
    const { embedding } = await this.requestEmbeddingCache.resolve(text);
    return embedding;
  }

  /**
   * 캠페인 점수 계산
   *
   * 1) 캠페인 태그 각각과 요청 텍스트의 유사도(s_i) 산출
   * 2) top-k(기본 3개) 유사도에 가중치 부여하여 S_top 계산
   * 3) 임계치(기본 0.45) 이상인 태그 개수로 coverage(S_cov) 계산
   * 4) exact match(문자열 기반) 보너스(S_exact) 적용
   * 5) 최종 Score = 0.70*S_top + 0.25*S_cov + 0.05*S_exact
   */
  private async scoreCampaignByTags(
    requestEmbedding: number[],
    requestNorm: string,
    requestTokens: Set<string>,
    campaign: MatchableCampaign
  ): Promise<number> {
    // CachedCampaign의 tags는 string[] 형태
    const tagNames = (campaign.tags ?? []).filter(Boolean);

    if (tagNames.length === 0) {
      return 0;
    }

    const sims: number[] = [];
    let exactMatch = false;

    for (const tagName of tagNames) {
      const tagNorm = this.normalizeText(tagName);
      const tagTokens = new Set(this.tokenizeText(tagName));

      // exact match 보너스는 "비슷한 의미지만 약어라서 임베딩이 흔들리는" 케이스를 조금 보완합니다.
      // - 토큰 교집합이 있으면(예: 요청 "sql 광고" vs 태그 "mysql") exactMatch로 간주합니다.
      // - 다만 너무 흔한 토큰이 많아질 경우 가중치/stopword를 추가로 조정할 수 있습니다.
      if (tagNorm.includes(' ')) {
        if (requestNorm.includes(tagNorm)) exactMatch = true;
      } else if (
        requestTokens.has(tagNorm) ||
        this.hasTokenOverlap(requestTokens, tagTokens)
      ) {
        exactMatch = true;
      }

      try {
        // Redis에 이미 캐싱된 임베딩을 우선 사용 (Worker가 생성)
        let tagEmbedding: ArrayLike<number>;

        if (campaign.embeddingTags && campaign.embeddingTags[tagName]) {
          // Redis에 이미 임베딩이 있으면 바로 사용
          tagEmbedding = campaign.embeddingTags[tagName];
        } else {
          // 없으면 새로 생성 (fallback)
          tagEmbedding = await this.getEmbeddingCached(tagName);
          if (this.logsEnabled) {
            this.logger.debug(
              `Redis 캐시 미스 - 태그 임베딩 새로 생성: "${tagName}" (campaign=${campaign.id})`
            );
          }
        }

        sims.push(
          this.mlEngine.calculateSimilarity(requestEmbedding, tagEmbedding)
        );
      } catch (error) {
        // 특정 태그 임베딩이 실패해도 전체 캠페인을 버리진 않고, 해당 태그만 스킵합니다.
        if (this.logsEnabled) {
          this.logger.debug(
            `태그 임베딩 실패로 스킵: "${tagName}" (campaign=${campaign.id})`,
            error as Error
          );
        }
      }
    }

    if (sims.length === 0) {
      return 0;
    }

    sims.sort((a, b) => b - a);

    // top-k 가중 평균: 강한 매칭(top1)을 가장 크게, 나머지는 점진적으로 반영
    const k = Math.min(this.TOP_K, sims.length);
    let sTop = 0;
    let wSum = 0;
    for (let i = 0; i < k; i++) {
      const w = this.TOP_K_WEIGHTS[i] ?? 0;
      wSum += w;
      sTop += sims[i] * w;
    }
    // 태그 수가 1~2개인 캠페인도 과도하게 불리하지 않도록 weight 합으로 정규화합니다.
    if (wSum > 0) sTop /= wSum;
    sTop = this.clamp01(sTop);

    // coverage: 임계치 이상으로 "의미 있게" 맞는 태그가 몇 개인지
    const coverageCount = sims.filter(
      (s) => s >= this.COVERAGE_THRESHOLD
    ).length;
    const sCov = this.clamp01(coverageCount / this.COVERAGE_SATURATION);

    const sExact = exactMatch ? 1 : 0;

    const finalScore =
      this.FINAL_WEIGHTS.top * sTop +
      this.FINAL_WEIGHTS.coverage * sCov +
      this.FINAL_WEIGHTS.exact * sExact;

    // 필요하면 아래 로그를 켜서 캠페인별 breakdown을 확인할 수 있습니다.
    // this.logger.debug(
    //   `Campaign ${campaign.id}: top=${sTop.toFixed(3)}, cov=${sCov.toFixed(
    //     3
    //   )}, exact=${sExact} => score=${finalScore.toFixed(3)}`
    // );

    return this.clamp01(finalScore);
  }
}
