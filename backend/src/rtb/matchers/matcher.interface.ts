import type { Candidate, DecisionContext } from '../types/decision.types';

export abstract class Matcher {
  /**
   * Redis에 저장된 캠페인 데이터들을 바탕으로 Active, IsHighIntent, 날짜 범위, 백테 유사도 비교값을 기반으로 후보 캠페인들 반환
   */
  abstract findCandidatesByTags(context: DecisionContext): Promise<Candidate[]>;
}
