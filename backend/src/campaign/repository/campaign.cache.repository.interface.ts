import {
  CachedCampaign,
  CachedCampaignWithoutSpent,
  CampaignTagVectorSearchHit,
  CampaignTagVectorSearchOptions,
} from '../types/campaign.types';

export abstract class CampaignCacheRepository {
  abstract saveCampaignCacheById(
    id: string,
    data: CachedCampaign,
    ttl?: number
  ): Promise<void>;

  abstract updateCampaignWithoutCachedById(
    id: string,
    data: CachedCampaignWithoutSpent
  ): Promise<void>;

  abstract findCampaignCacheById(id: string): Promise<CachedCampaign | null>;
  abstract findCampaignCachesByIds(ids: string[]): Promise<CachedCampaign[]>;

  // 상태만 업데이트 (embeddingTags 보존)
  abstract updateCampaignStatus(id: string, status: string): Promise<void>;

  abstract updateDailySpentCacheById(id: string, amount: number): Promise<void>;

  // 선제적 Spent 증가 (원자적 예산 검증 + 증가)
  // 예산 검증 통과 시 dailySpent += cpc, totalSpent += cpc 후 true 반환
  // 예산 초과 시 증가 없이 false 반환
  abstract incrementSpent(
    campaignId: string,
    cpc: number,
    dailyBudget: number,
    totalBudget: number | null
  ): Promise<boolean>;

  // Spent 롤백 (비딩 패배 시)
  // dailySpent -= cpc, totalSpent -= cpc
  abstract decrementSpent(campaignId: string, cpc: number): Promise<void>;

  // 태그 변경 시 임베딩 비우기
  abstract deleteCampaignEmbeddingById(id: string): Promise<void>;

  // 태그별 임베딩 업데이트
  abstract updateCampaignEmbeddingTags(
    id: string,
    embeddingTags: { [tagName: string]: number[] }
  ): Promise<void>;

  abstract deleteCampaignCacheById(id: string): Promise<void>;
  abstract existsCampaignCacheById(id: string): Promise<boolean>;

  // RTB 비딩용: 모든 캠페인 조회 (Redis에서)
  abstract getAllCampaigns(options?: {
    allowStale?: boolean;
  }): Promise<CachedCampaign[]>;

  // 일일 예산 리셋용 (자정 정산)
  abstract resetDailySpentCache(id: string): Promise<void>;

  abstract searchCampaignTagVectors(
    options: CampaignTagVectorSearchOptions
  ): Promise<CampaignTagVectorSearchHit[]>;
}
