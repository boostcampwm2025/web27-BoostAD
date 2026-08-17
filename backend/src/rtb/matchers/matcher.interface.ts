import type { DecisionContext, ScoredCandidate } from '../types/decision.types';

export type QualityRetrievalMode = 'dense_only' | 'hybrid';

export abstract class Matcher {
  /**
   * 요청 컨텍스트와 일치하는 캠페인을 조회하고 집행 자격과 매칭 점수를 반영해 반환한다.
   * 예산 검증과 예약은 호출부의 책임이다.
   */
  abstract matchCandidates(
    context: DecisionContext
  ): Promise<ScoredCandidate[]>;

  /**
   * 품질 benchmark용 ranking. 기본은 primary dense와 동일하다.
   * hybrid는 구현체가 Dense-primary Hybrid topK를 반환할 수 있다.
   */
  async findQualityRankings(
    context: DecisionContext,
    _mode: QualityRetrievalMode = 'dense_only'
  ): Promise<ScoredCandidate[]> {
    return this.matchCandidates(context);
  }
}
