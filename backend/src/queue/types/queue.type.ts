// Campaign 임베딩 Job (Worker가 Redis에서 태그 조회)
import { BidStatus } from '../../bid-log/bid-log.types';

export interface CampaignEmbeddingJobData {
  campaignId: string;
  text?: string; // 더 이상 사용하지 않음 (하위 호환성 유지)
}

export interface BlogEmbeddingJobData {
  blogId: number;
  text: string;
}

// Union 타입으로 통합
export type EmbeddingJobData = CampaignEmbeddingJobData | BlogEmbeddingJobData;

export interface BidLogJobItemData {
  campaignId: string;
  status: BidStatus;
  bidPrice: number;
  reason: string;
  userId: number;
  campaignTitle: string;
}

export interface BidLogJobData {
  auctionId: string;
  blogId: number;
  blogKey: string;
  blogName: string;
  isHighIntent: boolean;
  behaviorScore: number;
  postUrl: string;
  winAmount: number;
  items: BidLogJobItemData[];
}
