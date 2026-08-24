import type { ServingCampaign } from '../campaign/serving-campaign';
import type { Candidate } from './types/decision.types';

/**
 * 하이드레이션된 캠페인에서 요청별 경매 후보를 만든다.
 * 재채점에 사용한 임베딩은 후보·응답·로그로 전파하지 않는다.
 */
export function createCandidate(
  campaign: ServingCampaign,
  similarity: number
): Candidate {
  return {
    id: campaign.id,
    userId: campaign.userId,
    title: campaign.title,
    content: campaign.content,
    image: campaign.image,
    url: campaign.url,
    maxCpc: campaign.maxCpc,
    isHighIntent: campaign.isHighIntent,
    status: campaign.status,
    startDate: campaign.startDate,
    endDate: campaign.endDate,
    deletedAt: campaign.deletedAt,
    tags: campaign.tags ? [...campaign.tags] : undefined,
    similarity,
  };
}
