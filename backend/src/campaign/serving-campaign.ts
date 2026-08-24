import type { CachedCampaign, CampaignStatus } from './types/campaign.types';

/**
 * RTB 매칭과 광고 응답에 필요한 캠페인 조회 모델.
 * 예산과 spent는 예약 시점에 Redis에서 판정하므로 포함하지 않는다.
 */
export type ServingCampaign = {
  id: string;
  userId: number;
  title: string;
  content: string;
  image: string | null;
  url: string;
  maxCpc: number;
  isHighIntent: boolean;
  status: CampaignStatus;
  startDate: string;
  endDate: string;
  deletedAt: string | null;
  tags?: string[];
  embeddingTags?: Record<string, Float32Array>;
  embeddingModelVersion?: string;
  embeddingDocument?: Float32Array;
};

/**
 * Redis 저장 모델을 RTB 조회 모델로 명시적으로 projection한다.
 * 저장 모델에 필드가 추가돼도 이 함수에 선언하지 않은 값은 snapshot에 유입되지 않는다.
 */
export function toServingCampaign(campaign: CachedCampaign): ServingCampaign {
  const embeddingTags = campaign.embeddingTags
    ? Object.fromEntries(
        Object.entries(campaign.embeddingTags).map(([tagName, vector]) => [
          tagName,
          new Float32Array(vector),
        ])
      )
    : undefined;
  const embeddingDocument = campaign.embeddingDocument
    ? new Float32Array(campaign.embeddingDocument)
    : undefined;

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
    embeddingTags,
    embeddingModelVersion: campaign.embeddingModelVersion,
    embeddingDocument,
  };
}
