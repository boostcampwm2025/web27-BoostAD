import type { Candidate, ScoredCandidate } from '../types/decision.types';

// 추후 ML 모델 기반 스코어링 전략을 위해서 Promise 기반으로 정의
export abstract class Scorer {
  // 여러 캠페인 점수 (외부 API)
  /**
   *
   * @param candidates
   */
  abstract scoreCandidates(candidates: Candidate[]): Promise<ScoredCandidate[]>;
}
