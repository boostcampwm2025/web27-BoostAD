import type { CachedCampaign, Tag } from '../../campaign/types/campaign.types';

export interface Campaign {
  id: string;
  user_id: number;
  title: string;
  content: string;
  image: string;
  url: string;
  tags: Tag[];
  max_cpc: number;
  daily_budget: number;
  total_budget: number | null;
  is_high_intent: boolean;
  status: 'ACTIVE' | 'PAUSED' | 'PENDING' | 'ENDED';
  start_date: string;
  end_date: string;
  created_at: string;
  deleted_at: string | null;
}
export interface DecisionContext {
  blogKey: string;
  blogId: number; // Guard에서 가져온 값 (중복 조회 방지)
  blogName: string; // Guard에서 가져온 값 (SSE 이벤트 DB 조회 제거용)
  tags: string[];
  postUrl: string;
  behaviorScore: number;
  isHighIntent: boolean;
}

// export interface Tag {
//   id: number;
//   name: string;
// }

export interface Candidate {
  campaign: CachedCampaign; // Matcher가 Redis에서 조회한 CachedCampaign 반환
  similarity: number;
}

export interface ScoredCandidate extends CachedCampaign {
  score: number;
}

export interface ScoringResult {
  score: number;
  matchedTags: Tag[];
  breakdown: {
    cpc: number;
    matchCount: number;
    similarity?: number;
    otherBonus?: number;
  };
}

export interface SelectionResult {
  winner: ScoredCandidate;
  candidates: ScoredCandidate[];
}
