import type { DecisionContext, ScoredCandidate } from '../types/decision.types';

export type QualityRetrievalMode = 'dense_only' | 'hybrid_shadow';

export abstract class Matcher {
  /**
   * Redis에 저장된 캠페인 데이터들을 바탕으로 Active, IsHighIntent, 날짜 범위,
   * 벡터 유사도 기반 후보를 찾고 최종 점수까지 계산해 반환한다. (예산검증x)
   */
  abstract findCandidatesByTags(
    context: DecisionContext
  ): Promise<ScoredCandidate[]>;

  /**
   * 품질 benchmark용 ranking. 기본은 primary dense와 동일하다.
   * hybrid_shadow는 구현체가 RRF shadow topK를 반환할 수 있다.
   */
  async findQualityRankings(
    context: DecisionContext,
    _mode: QualityRetrievalMode = 'dense_only'
  ): Promise<ScoredCandidate[]> {
    return this.findCandidatesByTags(context);
  }
}
