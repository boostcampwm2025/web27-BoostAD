import type { DecisionContext, ScoredCandidate } from '../types/decision.types';

export abstract class Matcher {
  /**
   * Redis에 저장된 캠페인 데이터들을 바탕으로 Active, IsHighIntent, 날짜 범위,
   * 벡터 유사도 기반 후보를 찾고 최종 점수까지 계산해 반환한다. (예산검증x)
   */
  abstract findCandidatesByTags(
    context: DecisionContext
  ): Promise<ScoredCandidate[]>;
}
