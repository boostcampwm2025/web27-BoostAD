import type { ScoredCandidate, SelectionResult } from '../types/decision.types';

export abstract class CampaignSelector {
  abstract rankCandidates(
    candidates: ScoredCandidate[]
  ): Promise<SelectionResult>;
}
