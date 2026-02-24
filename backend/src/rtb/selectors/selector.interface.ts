import type { ScoredCandidate, SelectionResult } from '../types/decision.types';

export abstract class CampaignSelector {
  /**
   * 
   * @param candidates 유사도 계산이 끝난 캠페인 
   */
  abstract selectWinner(
    candidates: ScoredCandidate[]
  ): Promise<SelectionResult>;
}
