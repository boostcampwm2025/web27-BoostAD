import type { ScoredCandidate, SelectionResult } from '../types/decision.types';

export abstract class CampaignSelector {
  abstract selectWinner(
    candidates: ScoredCandidate[]
  ): Promise<SelectionResult>;
}
