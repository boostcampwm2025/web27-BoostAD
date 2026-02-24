import { Injectable, Logger } from '@nestjs/common';
import { Matcher } from './matcher.interface';
import { CampaignCacheRepository } from '../../campaign/repository/campaign.cache.repository.interface';
import { MLEngine } from '../ml/mlEngine.interface';
import type { Candidate, DecisionContext } from '../types/decision.types';
import type { CachedCampaign } from '../../campaign/types/campaign.types';
@Injectable()
export class TransformerMatcher extends Matcher {
  private readonly logger = new Logger(TransformerMatcher.name);

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

  // 임베딩은 계산 비용이 높아서(모델 호출), 태그 문자열 기준으로 간단 캐싱합니다.
  private readonly embeddingCache = new Map<string, number[]>();
  private readonly EMBEDDING_CACHE_MAX_SIZE = 1_000;

  constructor(
    private readonly campaignCacheRepo: CampaignCacheRepository,
    private readonly mlEngine: MLEngine
  ) {
    super();
  }

  //  ML 모델(Transformer)을 사용하여 문맥(Tags)과 유사도가 높은 캠페인 후보를 찾습니다.
  async findCandidatesByTags(context: DecisionContext): Promise<Candidate[]> {
    // ML 모델 준비 안 됐으면 빈 배열 반환 (Scorer에서 태그 매칭으로 커버 예정)
    if (!this.mlEngine.isReady()) {
      this.logger.warn('ML 모델이 준비가 안 되었습니다.');
      return [];
    }

    const requestText = this.buildRequestText(context.tags);
    const requestNorm = this.normalizeText(requestText);
    const requestTokens = new Set(this.tokenizeText(requestText));

    // Redis에서 모든 캠페인 조회 (캐시 우선 전략)
    const allCampaigns = await this.campaignCacheRepo.getAllCampaigns();

    // 비딩 자격 필터링: ACTIVE + 날짜 범위 + deletedAt + embeddingTags + isHighIntent 존재
    const eligibleCampaigns = this.filterEligibleCampaigns(
      allCampaigns,
      context.isHighIntent
    );

    if (eligibleCampaigns.length === 0) {
      this.logger.debug('비딩 가능한 캠페인이 없습니다.');
      return [];
    }

    let requestEmbedding: number[];
    try {
      // 요청 임베딩은 모든 캠페인 비교에서 공통으로 사용되므로 한 번만 계산합니다.
      requestEmbedding = await this.getEmbeddingCached(requestText);
      // requestEmbedding = await this.mlEngine.getEmbedding(requestText);
    } catch (error) {
      this.logger.warn('요청 태그 임베딩 생성에 실패했습니다.', error as Error);
      return [];
    }

    // 자격 있는 캠페인과 스코어 계산 (0~1)
    // - Promise.all(대량)로 한 번에 태스크를 쌓으면, 대규모 캠페인에서 메모리/마이크로태스크 오버헤드가 커질 수 있음, 게다가 여기서 굳이 Promise.all 쓸 이유없음
    //   순차 계산 + 임계값 통과 케이스만 후보로 유지
    const candidates: Candidate[] = [];
    for (const campaign of eligibleCampaigns) {
      const similarity = await this.scoreCampaignByTags(
        requestEmbedding,
        requestNorm,
        requestTokens,
        campaign
      );
      if (similarity >= this.SIMILARITY_THRESHOLD) {
        candidates.push({ campaign, similarity });
      }
    }

    this.logger.debug(
      `필터링된 캠페인 수 ${candidates.length}/${allCampaigns.length} 캠페인의 유사도 (임계값: ${this.SIMILARITY_THRESHOLD})`
    );

    return candidates;
  }

  // 요청 태그 배열을 임베딩을 위한 단일 텍스트로 변환합니다.
  private buildRequestText(tags: string[]): string {
    return tags.join(' ');
  }

  // 비딩 자격 필터링: ACTIVE + 날짜 범위 + deletedAt + embeddingTags 존재
  private filterEligibleCampaigns(
    campaigns: CachedCampaign[],
    isHighIntent: boolean
  ): CachedCampaign[] {
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
        !campaign.embeddingTags ||
        Object.keys(campaign.embeddingTags).length === 0
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
    return text.toLowerCase().replace(/\s+/g, ' ').trim();
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

  private async getEmbeddingCached(text: string): Promise<number[]> {
    const key = this.normalizeText(text);
    const cached = this.embeddingCache.get(key);
    if (cached) {
      // LRU: recency 갱신
      this.embeddingCache.delete(key);
      this.embeddingCache.set(key, cached);
      return cached;
    }

    const embedding = await this.mlEngine.getEmbedding(text);
    this.embeddingCache.set(key, embedding);

    // LRU eviction (최대 크기 초과 시 가장 오래된 항목 제거)
    if (this.embeddingCache.size > this.EMBEDDING_CACHE_MAX_SIZE) {
      const oldestKey = this.embeddingCache.keys().next().value as
        | string
        | undefined;
      if (oldestKey) this.embeddingCache.delete(oldestKey);
    }
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
    campaign: CachedCampaign
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
        let tagEmbedding: number[];

        if (campaign.embeddingTags && campaign.embeddingTags[tagName]) {
          // Redis에 이미 임베딩이 있으면 바로 사용
          tagEmbedding = campaign.embeddingTags[tagName];
        } else {
          // 없으면 새로 생성 (fallback)
          tagEmbedding = await this.getEmbeddingCached(tagName);
          this.logger.debug(
            `Redis 캐시 미스 - 태그 임베딩 새로 생성: "${tagName}" (campaign=${campaign.id})`
          );
        }

        sims.push(
          this.mlEngine.calculateSimilarity(requestEmbedding, tagEmbedding)
        );
      } catch (error) {
        // 특정 태그 임베딩이 실패해도 전체 캠페인을 버리진 않고, 해당 태그만 스킵합니다.
        this.logger.debug(
          `태그 임베딩 실패로 스킵: "${tagName}" (campaign=${campaign.id})`,
          error as Error
        );
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
