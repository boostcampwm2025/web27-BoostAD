import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { CampaignCacheRepository } from '../../campaign/repository/campaign.cache.repository.interface';
import {
  CampaignServingSnapshotService,
  type ServingCampaign,
} from '../../campaign/campaign-serving-snapshot.service';
import { toServingCampaign } from '../../campaign/serving-campaign';
import { MLEngine } from '../ml/mlEngine.interface';
import { RequestEmbeddingCacheService } from '../ml/request-embedding-cache.service';
import type { EmbeddingPendingReason } from '../ml/request-embedding-cache.service';
import { ContextEmbeddingService } from '../context/context-embedding.service';
import type { DecisionContext, ScoredCandidate } from '../types/decision.types';
import { MetricsService } from '../../metrics/metrics.service';
import {
  createRtbPathLogger,
  rtbPathLogsEnabled,
} from '../../common/logging/rtb-path-logger.util';
import { Matcher, type QualityRetrievalMode } from './matcher.interface';
import {
  fuseHybridRankings,
  type RetrievalHit,
} from '../retrieval/hybrid-retrieval.fusion';
import { createCandidate } from '../candidate.factory';

type DenseRetrievalMode = 'legacy_tag' | 'semantic_document';
type RetrievalMode = 'dense_only' | 'hybrid';

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
  private readonly denseRetrievalMode: DenseRetrievalMode;
  private readonly documentSimilarityThreshold: number;
  private readonly retrievalMode: RetrievalMode;
  private readonly hybridRrfK: number;
  private readonly hybridDenseWeight: number;
  private readonly hybridSparseWeight: number;
  private readonly hybridSparseSupplementLimit: number;
  private readonly hybridFinalLimit: number;

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
    const denseRetrievalMode = this.configService.get<string>(
      'RTB_DENSE_RETRIEVAL_MODE',
      'semantic_document'
    );
    if (
      denseRetrievalMode !== 'legacy_tag' &&
      denseRetrievalMode !== 'semantic_document'
    ) {
      throw new Error(
        `지원하지 않는 RTB_DENSE_RETRIEVAL_MODE입니다: ${denseRetrievalMode}`
      );
    }
    this.denseRetrievalMode = denseRetrievalMode;
    this.documentSimilarityThreshold = this.getNonNegativeFloatEnv(
      'RTB_MATCHER_DOCUMENT_SIMILARITY_THRESHOLD',
      0.3
    );
    const retrievalMode = this.configService.get<string>(
      'RTB_RETRIEVAL_MODE',
      'dense_only'
    );
    if (retrievalMode !== 'dense_only' && retrievalMode !== 'hybrid') {
      throw new Error(
        `지원하지 않는 RTB_RETRIEVAL_MODE입니다: ${retrievalMode}`
      );
    }
    this.retrievalMode = retrievalMode;
    this.hybridRrfK = this.getPositiveIntEnv('RTB_HYBRID_RRF_K', 60);
    this.hybridDenseWeight = this.getNonNegativeFloatEnv(
      'RTB_HYBRID_DENSE_WEIGHT',
      1
    );
    this.hybridSparseWeight = this.getNonNegativeFloatEnv(
      'RTB_HYBRID_SPARSE_WEIGHT',
      0.2
    );
    this.hybridSparseSupplementLimit = this.getPositiveIntEnv(
      'RTB_HYBRID_SPARSE_SUPPLEMENT_LIMIT',
      10
    );
    this.hybridFinalLimit = this.getPositiveIntEnv(
      'RTB_HYBRID_FINAL_LIMIT',
      10
    );
  }

  /**
   * 요청 컨텍스트에 맞는 캠페인을 검색·필터링·채점한다. 예산은 검증하지 않는다.
   * ANN이 켜져 있으면 설정된 dense retrieval 경로로 후보를 좁히고,
   * 꺼져 있으면 전체 캠페인을 조회해 자격 필터링과 태그 기반 채점을 수행한다.
   *
   * 요청 임베딩 확보 우선순위:
   *  1) contextId가 있으면 사전 생성된 글 임베딩 사용
   *  2) cold-miss fast path에서는 태그 임베딩 캐시 hit만 사용
   *  3) 구 동기 경로에서는 캐시 miss 시 runtime 생성을 기다림
   */
  async matchCandidates(context: DecisionContext): Promise<ScoredCandidate[]> {
    // [1. 매칭 입력 준비]
    // 요청 태그를 정규화한 텍스트·문자열·토큰 형태로 준비한다.
    // 임베딩은 semantic 검색에, 정규화 문자열과 토큰은 legacy 태그 재채점에 사용한다.
    const requestText = this.buildRequestText(context.tags);
    const requestNorm = this.normalizeText(requestText);
    const requestTokens = new Set(this.tokenizeText(requestText));

    // [종료 분기 A: ML 모델 미준비]
    // fast path가 켜져 있으면 모델 없이 lexical 후보를 반환하고, 아니면 빈 결과를 반환한다.
    if (!this.mlEngine.isReady()) {
      if (this.coldMissFastPathEnabled) {
        return this.findCandidatesByLexicalFallback(context, 'model_not_ready');
      }

      this.metricsService.incRtbFallback('matcher_empty');
      if (this.logsEnabled) {
        this.logger.warn('ML 모델이 준비가 안 되었습니다.');
      }
      return [];
    }

    // [2. 요청 임베딩 확보]
    // context 임베딩을 우선 사용하고, 불가능할 때 설정에 따라 캐시 fast path 또는 동기 경로를 사용한다.
    let requestEmbedding: number[];
    const requestEmbeddingStartedAt = process.hrtime.bigint();

    try {
      // [분기 B-1: 사전 생성된 context 임베딩]
      // SDK observe 단계에서 발급한 contextId가 있으면 포스트 문맥 임베딩 상태를 조회한다.
      if (this.contextDecisionEnabled && context.contextId) {
        const contextResult =
          await this.contextEmbeddingService.resolveForDecision(
            context.contextId
          );

        this.metricsService.recordRtbContextDecision(contextResult.status);

        // context 임베딩을 기다리지 않고 PENDING/FAILED 상태는 즉시 lexical 경로로 전환한다.
        if (contextResult.status !== 'READY') {
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
        // [분기 B-2: deprecated cold-miss fast path]
        // 태그 임베딩 캐시 hit만 즉시 사용한다. miss면 생성을 예약하고 현재 요청은 lexical로 처리한다.
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
        // [분기 B-3: deprecated 동기 임베딩 경로]
        // 캐시 miss가 발생해도 runtime 임베딩 생성이 끝날 때까지 기다린다.
        requestEmbedding = await this.getEmbeddingCached(requestText);
      }

      // 세 임베딩 경로 중 하나가 정상적으로 벡터를 확보한 경우에만 ok로 기록한다.
      this.metricsService.recordRtbStage(
        'match_request_embedding',
        'ok',
        this.elapsedMs(requestEmbeddingStartedAt)
      );
    } catch (error) {
      // [오류 분기 B-4: 요청 임베딩 확보 실패]
      // fast path에서는 lexical로 복구하고, 동기 경로에서는 오류를 기록한 뒤 빈 결과를 반환한다.
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

    // [3. 후보 검색 방식 분기]
    // ANN 모드는 dense 설정에 따라 semantic document 또는 legacy tag 검색으로 진입한다.
    if (this.annEnabled) {
      return this.findCandidatesByAnn(
        context,
        requestEmbedding,
        requestNorm,
        requestTokens
      );
    }

    // [4. ANN OFF: 전체 캠페인 조회]
    // 후보 축소 인덱스를 사용하지 않으므로 Redis에서 모든 캠페인을 불러온다.
    const getAllCampaignsStartedAt = process.hrtime.bigint();
    const allCampaigns = (await this.campaignCacheRepo.getAllCampaigns()).map(
      toServingCampaign
    );
    this.metricsService.recordRtbStage(
      'match_get_all_campaigns',
      'ok',
      this.elapsedMs(getAllCampaignsStartedAt)
    );

    // [5. ANN OFF: 집행 자격 필터링]
    // ACTIVE/집행 기간/삭제/high-intent/태그 임베딩 조건을 만족하는 캠페인만 남긴다.
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

    // [종료 분기 C: 집행 가능한 캠페인 없음]
    if (eligibleCampaigns.length === 0) {
      this.metricsService.incRtbFallback('matcher_empty');
      if (this.logsEnabled) {
        this.logger.debug('비딩 가능한 캠페인이 없습니다.');
      }
      return [];
    }

    // [6. ANN OFF: 태그 기반 재채점]
    // 전체 자격 캠페인의 유사도·coverage·exact match를 계산하고 임계값 통과 후보를 반환한다.
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
      | 'semantic_index_unready'
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
          campaign,
          coverage,
          exactMatchCount,
        };
      })
      .filter((item) => item.exactMatchCount > 0)
      .sort((a, b) => {
        if (b.exactMatchCount !== a.exactMatchCount) {
          return b.exactMatchCount - a.exactMatchCount;
        }
        if (b.coverage !== a.coverage) {
          return b.coverage - a.coverage;
        }
        if (b.campaign.maxCpc !== a.campaign.maxCpc) {
          return b.campaign.maxCpc - a.campaign.maxCpc;
        }
        return a.campaign.id.localeCompare(b.campaign.id);
      })
      .slice(0, this.lexicalTopM)
      .map(({ campaign, coverage, exactMatchCount }) => ({
        ...this.buildCandidate(campaign, coverage),
        score: exactMatchCount * 100 + coverage * 10,
      }));

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

  private getNonNegativeFloatEnv(name: string, defaultValue: number): number {
    const raw = this.configService.get<string>(name);
    const parsed = raw === undefined ? defaultValue : Number.parseFloat(raw);
    if (!Number.isFinite(parsed) || parsed < 0) {
      return defaultValue;
    }
    return parsed;
  }

  /**
   * 데이터 소스와 관계없이 matcher에는 동일한 RTB 조회 모델만 전달한다.
   */
  private async findServingCampaignsByIds(
    ids: string[]
  ): Promise<ServingCampaign[]> {
    if (this.localSnapshotEnabled) {
      return this.campaignServingSnapshot.findCampaignsByIds(ids);
    }

    const cachedCampaigns =
      await this.campaignCacheRepo.findCampaignCachesByIds(ids);
    return cachedCampaigns.map(toServingCampaign);
  }

  /**
   * 설정된 dense retrieval 모드에 따라 ANN 후보 검색을 수행한다.
   * semantic_document는 문서 유사도를 최종 매칭 신호로 사용하고,
   * legacy_tag는 ANN을 후보 축소에만 사용한 뒤 태그 기반으로 다시 채점한다.
   */
  private async findCandidatesByAnn(
    context: DecisionContext,
    requestEmbedding: number[],
    requestNorm: string,
    requestTokens: Set<string>
  ): Promise<ScoredCandidate[]> {
    // [분기 A: semantic document ANN]
    // 문서 ANN 검색부터 hydrate·자격 검증·점수 생성까지 전용 흐름에 위임한다.
    if (this.denseRetrievalMode === 'semantic_document') {
      return this.findCandidatesByDocumentAnn(context, requestEmbedding);
    }

    // [1. legacy tag ANN 검색]
    // 요청 벡터와 가까운 캠페인 태그를 top-L까지 조회한다.
    // 이 유사도는 최종 점수가 아니라 재채점할 캠페인을 좁히는 retrieval 신호다.
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

    // [종료 분기 B: ANN 태그 hit 없음]
    // legacy tag 인덱스에서 후보를 찾지 못하면 재채점 없이 빈 결과를 반환한다.
    if (tagHits.length === 0) {
      this.metricsService.incRtbFallback('matcher_empty');
      if (this.logsEnabled) {
        this.logger.debug('ANN retrieval 결과가 비어 있습니다.');
      }
      return [];
    }

    // [2. 태그 hit를 캠페인 단위로 집계]
    // 캠페인별 상위 태그 유사도와 coverage로 retrieval 순위를 만든 뒤 top-M ID만 유지한다.
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

    // [종료 분기 C: 캠페인 ID 집계 결과 없음]
    if (retrievedCampaignIds.length === 0) {
      this.metricsService.incRtbFallback('matcher_empty');
      return [];
    }

    // [3. 검색 후보 hydrate]
    // ANN hit에 없는 CPC·광고 소재·집행 조건을 snapshot 또는 Redis에서 조회한다.
    const loadRetrievedStartedAt = process.hrtime.bigint();
    const retrievedCampaigns =
      await this.findServingCampaignsByIds(retrievedCampaignIds);
    this.metricsService.recordRtbStage(
      this.localSnapshotEnabled
        ? 'match_campaign_hydrate_snapshot'
        : 'match_campaign_hydrate_redis',
      'ok',
      this.elapsedMs(loadRetrievedStartedAt)
    );

    // [4. 집행 자격 재검증]
    // ANN 조회 이후 상태 변경 가능성을 고려해 ACTIVE/기간/삭제/high-intent/태그 임베딩 조건을 확인한다.
    const eligibleCampaigns = this.filterEligibleCampaigns(
      retrievedCampaigns,
      context.isHighIntent
    );

    // [종료 분기 D: 집행 가능한 검색 후보 없음]
    if (eligibleCampaigns.length === 0) {
      this.metricsService.incRtbFallback('matcher_empty');
      return [];
    }

    // [5. legacy tag 최종 재채점]
    // ANN retrieval 순위를 그대로 쓰지 않고 태그별 top-k·coverage·exact match로 유사도를 다시 계산한다.
    return this.scoreEligibleCampaigns(
      eligibleCampaigns,
      requestEmbedding,
      requestNorm,
      requestTokens,
      eligibleCampaigns.length
    );
  }

  /**
   * 문서 ANN Top-L 검색
   * → 유사도 임계값 적용
   * → Top-M 후보 축소
   * → 캠페인 데이터 hydrate
   * → 집행 조건 재검증
   * → 문서 유사도와 CPC로 점수 생성
   * → 필요하면 Hybrid 결과 결합
   * → 최종 후보 반환
   *
   * 문서 ANN 결과 자체가 없으면 lexical fallback으로 전환한다.
   */
  private async findCandidatesByDocumentAnn(
    context: DecisionContext,
    requestEmbedding: number[]
  ): Promise<ScoredCandidate[]> {
    // [1. Dense retrieval]
    // 요청 문서 임베딩과 가까운 캠페인 문서를 ANN 인덱스에서 넓게(top-L) 조회한다.
    const annSearchStartedAt = process.hrtime.bigint();
    const documentHits =
      await this.campaignCacheRepo.searchCampaignDocumentVectors({
        queryEmbedding: requestEmbedding,
        topL: this.annTopL,
        isHighIntent: context.isHighIntent,
        nowTs: Date.now(),
      });
    this.metricsService.recordRtbStage(
      'match_ann_document_search',
      'ok',
      this.elapsedMs(annSearchStartedAt)
    );

    // [종료 분기 A: semantic 인덱스 미준비]
    // 검색 결과 자체가 없으면 인덱스를 사용할 수 없는 상태로 보고 lexical 경로로 전환한다.
    if (documentHits.length === 0) {
      return this.findCandidatesByLexicalFallback(
        context,
        'semantic_index_unready'
      );
    }

    // [2. Dense 후보 축소]
    // 최소 유사도를 통과한 결과만 남긴 뒤 실제로 hydrate할 후보 수를 top-M으로 제한한다.
    const retainedHits = documentHits
      .filter((hit) => hit.similarity >= this.documentSimilarityThreshold)
      .slice(0, this.annTopM);
    this.metricsService.observeRtbAnnRetrievedCampaignCount(
      retainedHits.length
    );

    // [종료 분기 B: 유사도 통과 후보 없음]
    // 인덱스는 정상이지만 기준을 만족하는 캠페인이 없으므로 fallback 없이 빈 후보를 반환한다.
    if (retainedHits.length === 0) {
      this.metricsService.incRtbFallback('matcher_empty');
      return [];
    }

    // [3. 캠페인 hydrate]
    // ANN hit에는 입찰에 필요한 전체 정보가 없으므로 ID로 serving campaign을 조회한다.
    // 설정에 따라 프로세스 로컬 snapshot 또는 Redis JSON을 데이터 소스로 사용한다.
    const loadStartedAt = process.hrtime.bigint();
    const ids = retainedHits.map((hit) => hit.campaignId);
    const retrievedCampaigns = await this.findServingCampaignsByIds(ids);
    this.metricsService.recordRtbStage(
      this.localSnapshotEnabled
        ? 'match_campaign_hydrate_snapshot'
        : 'match_campaign_hydrate_redis',
      'ok',
      this.elapsedMs(loadStartedAt)
    );

    // [4. 집행 자격 재검증]
    // hydrate 사이의 상태 변경 가능성을 고려해 ACTIVE/기간/삭제/high-intent 조건을 다시 확인한다.
    // 문서 ANN 경로는 태그 임베딩으로 재채점하지 않으므로 embeddingTags 존재 여부는 요구하지 않는다.
    const eligibleById = new Map(
      this.filterEligibleCampaigns(
        retrievedCampaigns,
        context.isHighIntent,
        false
      ).map((campaign) => [campaign.id, campaign])
    );

    // [5. 최종 후보 점수 생성]
    // 태그 기반 scoreCampaignByTags()를 거치지 않고 ANN이 반환한 문서 유사도를 그대로 사용한다.
    // buildCandidate()에서 CPC 30%와 문서 유사도 70%를 합산한다.
    const scoreStartedAt = process.hrtime.bigint();
    const candidates = retainedHits.flatMap((hit) => {
      const campaign = eligibleById.get(hit.campaignId);
      return campaign ? [this.buildCandidate(campaign, hit.similarity)] : [];
    });
    this.metricsService.recordRtbStage(
      'match_document_rerank',
      'ok',
      this.elapsedMs(scoreStartedAt)
    );
    this.metricsService.observeRtbEligibleCampaignCount(eligibleById.size);

    // [종료 분기 C: hydrate/자격 검증 후 후보 없음]
    if (candidates.length === 0) {
      this.metricsService.incRtbFallback('matcher_empty');
      return [];
    }

    // [6. 결과 반환 방식 분기]
    // hybrid 모드는 dense 후보에 sparse 검색 결과를 결합하고, 결합 결과가 비면 dense 결과를 유지한다.
    if (this.retrievalMode === 'hybrid') {
      const hybrid = await this.buildHybridCandidates(
        context,
        requestEmbedding,
        retainedHits,
        candidates
      );
      return hybrid.length > 0 ? hybrid : candidates;
    }

    // dense_only 모드는 문서 ANN 후보를 그대로 반환한다.
    return candidates;
  }

  async findQualityRankings(
    context: DecisionContext,
    mode: QualityRetrievalMode = 'dense_only'
  ): Promise<ScoredCandidate[]> {
    const requestText = this.buildRequestText(context.tags);
    const requestEmbedding = await this.resolveRequestEmbeddingForQuality(
      context,
      requestText
    );
    if (!requestEmbedding) {
      return [];
    }

    const documentHits =
      await this.campaignCacheRepo.searchCampaignDocumentVectors({
        queryEmbedding: requestEmbedding,
        topL: this.annTopL,
        isHighIntent: context.isHighIntent,
        nowTs: Date.now(),
      });
    const retainedHits = documentHits
      .filter((hit) => hit.similarity >= this.documentSimilarityThreshold)
      .slice(0, this.annTopM);
    const ids = retainedHits.map((hit) => hit.campaignId);
    const retrievedCampaigns = await this.findServingCampaignsByIds(ids);
    const eligibleById = new Map(
      this.filterEligibleCampaigns(
        retrievedCampaigns,
        context.isHighIntent,
        false
      ).map((campaign) => [campaign.id, campaign])
    );
    const primary = retainedHits.flatMap((hit) => {
      const campaign = eligibleById.get(hit.campaignId);
      return campaign ? [this.buildCandidate(campaign, hit.similarity)] : [];
    });
    if (mode === 'dense_only') {
      return primary;
    }

    const hybrid = await this.buildHybridCandidates(
      context,
      requestEmbedding,
      retainedHits,
      primary
    );
    return hybrid.length > 0 ? hybrid : primary;
  }

  private async resolveRequestEmbeddingForQuality(
    context: DecisionContext,
    requestText: string
  ): Promise<number[] | null> {
    if (this.contextDecisionEnabled && context.contextId) {
      const ready = await this.contextEmbeddingService.resolveForDecision(
        context.contextId
      );
      if (ready.status === 'READY' && ready.embedding?.length) {
        return ready.embedding;
      }
    }
    if (!this.mlEngine.isReady()) {
      return null;
    }
    return this.mlEngine.getEmbedding(requestText, 'query');
  }

  private async buildHybridCandidates(
    context: DecisionContext,
    requestEmbedding: number[],
    denseHits: Array<{ campaignId: string; similarity: number }>,
    primary: ScoredCandidate[]
  ): Promise<ScoredCandidate[]> {
    const sparseStartedAt = process.hrtime.bigint();
    const sparseRanked = await this.rankSparseTagCandidates(context);
    this.metricsService.observeRtbHybridSparseLookupDuration(
      this.elapsedMs(sparseStartedAt) / 1000
    );

    const denseRetrievalHits: RetrievalHit[] = denseHits.map((hit) => ({
      campaignId: hit.campaignId,
      rawScore: hit.similarity,
    }));
    const sparseRetrievalHits: RetrievalHit[] = sparseRanked.map(
      (candidate) => ({
        campaignId: candidate.id,
        rawScore: candidate.similarity,
      })
    );

    const fusionStartedAt = process.hrtime.bigint();
    const fused = fuseHybridRankings(denseRetrievalHits, sparseRetrievalHits, {
      rrfK: this.hybridRrfK,
      denseWeight: this.hybridDenseWeight,
      sparseWeight: this.hybridSparseWeight,
      limit: denseRetrievalHits.length + sparseRetrievalHits.length,
    });
    this.metricsService.observeRtbHybridFusionDuration(
      this.elapsedMs(fusionStartedAt) / 1000
    );
    this.metricsService.recordRtbStage(
      'match_hybrid_fusion',
      fused.length > 0 ? 'ok' : 'fallback',
      this.elapsedMs(fusionStartedAt)
    );

    if (fused.length === 0) {
      return [];
    }

    const denseCandidates = fused.filter((item) => item.dense);
    const sparseSupplements = fused
      .filter((item) => !item.dense && item.sparse)
      .slice(0, this.hybridSparseSupplementLimit);
    const rerankPool = [...denseCandidates, ...sparseSupplements];
    const rerankStartedAt = process.hrtime.bigint();
    const rerankIds = rerankPool.map((item) => item.campaignId);
    const hydratedPool = await this.findServingCampaignsByIds(rerankIds);
    const eligibleById = new Map(
      this.filterEligibleCampaigns(
        hydratedPool,
        context.isHighIntent,
        false
      ).map((campaign) => [campaign.id, campaign])
    );

    const exactReranked = rerankPool.flatMap((item) => {
      const campaign = eligibleById.get(item.campaignId);
      const documentEmbedding = campaign?.embeddingDocument;
      if (!campaign || !documentEmbedding?.length) {
        return [];
      }
      const exactSimilarity = this.mlEngine.calculateSimilarity(
        requestEmbedding,
        documentEmbedding
      );
      if (exactSimilarity < this.documentSimilarityThreshold) {
        return [];
      }
      const candidate = this.buildCandidate(campaign, exactSimilarity);
      // Sparse는 semantic exact score를 뒤집는 주 신호가 아니라 근접 후보의
      // tie-break 보너스로만 사용한다. 기본값에서 RRF 보너스는 1점 미만이다.
      candidate.score += (item.sparse?.contribution ?? 0) * 100;
      return [{ candidate, denseBacked: Boolean(item.dense) }];
    });

    const bestDenseScore = exactReranked
      .filter((item) => item.denseBacked)
      .reduce(
        (best, item) => Math.max(best, item.candidate.score),
        Number.NEGATIVE_INFINITY
      );
    if (!Number.isFinite(bestDenseScore)) {
      return primary.slice(0, this.hybridFinalLimit);
    }

    // Sparse-only 후보는 Top-K를 보충할 수 있지만 winner는 Dense 후보가 맡는다.
    for (const item of exactReranked) {
      if (!item.denseBacked && item.candidate.score >= bestDenseScore) {
        item.candidate.score = bestDenseScore - 1e-9;
      }
    }

    // Sparse 보너스나 exact 재계산이 현재 Dense winner를 바꾸지 않도록 하고,
    // Hybrid 개선은 2~10위 reserve 후보에만 반영한다.
    const denseWinner = [...primary].sort((left, right) => {
      if (right.score !== left.score) return right.score - left.score;
      if (right.maxCpc !== left.maxCpc) return right.maxCpc - left.maxCpc;
      return left.id.localeCompare(right.id);
    })[0];
    const lockedWinner = exactReranked.find(
      (item) => item.candidate.id === denseWinner?.id
    );
    if (lockedWinner) {
      const bestOtherScore = exactReranked
        .filter((item) => item !== lockedWinner)
        .reduce(
          (best, item) => Math.max(best, item.candidate.score),
          Number.NEGATIVE_INFINITY
        );
      if (lockedWinner.candidate.score <= bestOtherScore) {
        lockedWinner.candidate.score = bestOtherScore + 1e-9;
      }
    }

    const result = exactReranked
      .map((item) => item.candidate)
      .sort((left, right) => {
        if (right.score !== left.score) return right.score - left.score;
        if (right.similarity !== left.similarity) {
          return right.similarity - left.similarity;
        }
        if (right.maxCpc !== left.maxCpc) return right.maxCpc - left.maxCpc;
        return left.id.localeCompare(right.id);
      })
      .slice(0, this.hybridFinalLimit);
    this.metricsService.recordRtbStage(
      'match_hybrid_exact_rerank',
      result.length > 0 ? 'ok' : 'fallback',
      this.elapsedMs(rerankStartedAt)
    );
    return result;
  }

  private async rankSparseTagCandidates(
    context: DecisionContext
  ): Promise<ScoredCandidate[]> {
    const requestTags = new Set(
      context.tags.map((tag) => this.normalizeText(tag)).filter(Boolean)
    );
    if (requestTags.size === 0 || !this.localSnapshotEnabled) {
      return [];
    }

    const taggedCampaigns =
      await this.campaignServingSnapshot.findCampaignsByTags([...requestTags]);
    const eligibleCampaigns = this.filterEligibleCampaigns(
      taggedCampaigns,
      context.isHighIntent,
      false
    );

    return eligibleCampaigns
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
          campaign,
          exactMatchCount,
          coverage,
        };
      })
      .filter((item) => item.exactMatchCount > 0)
      .sort((a, b) => {
        if (b.exactMatchCount !== a.exactMatchCount) {
          return b.exactMatchCount - a.exactMatchCount;
        }
        if (b.coverage !== a.coverage) {
          return b.coverage - a.coverage;
        }
        if (b.campaign.maxCpc !== a.campaign.maxCpc) {
          return b.campaign.maxCpc - a.campaign.maxCpc;
        }
        return a.campaign.id.localeCompare(b.campaign.id);
      })
      .slice(0, this.lexicalTopM)
      .map(({ campaign, coverage }) => this.buildCandidate(campaign, coverage));
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

  /**
   * 캠페인과 요청 임베딩, norm, 토큰을 비교해서 점수 산출
   * @param eligibleCampaigns 캠페인 후보군
   * @param requestEmbedding 요청 벡터 임베딩
   * @param requestNorm
   * @param requestTokens
   * @param totalCampaignCount
   * @returns
   */
  private async scoreEligibleCampaigns(
    eligibleCampaigns: ServingCampaign[],
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
    campaign: ServingCampaign,
    similarity: number
  ): ScoredCandidate {
    const cpcScore = campaign.maxCpc * this.CPC_WEIGHT;
    const similarityScore = similarity * 100 * this.SIMILARITY_WEIGHT;

    return {
      ...createCandidate(campaign, similarity),
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
    campaigns: ServingCampaign[],
    isHighIntent: boolean,
    requireEmbeddings = true
  ): ServingCampaign[] {
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
    campaign: ServingCampaign
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
