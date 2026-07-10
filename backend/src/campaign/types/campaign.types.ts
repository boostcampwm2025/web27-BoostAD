export type CampaignStatus = 'PENDING' | 'ACTIVE' | 'PAUSED' | 'ENDED';

export type Campaign = {
  id: string;
  userId: number;
  title: string;
  content: string;
  image: string;
  url: string;
  maxCpc: number;
  dailyBudget: number;
  totalBudget: number | null;
  dailySpent: number;
  totalSpent: number;
  lastResetDate: Date;
  isHighIntent: boolean;
  status: CampaignStatus;
  startDate: Date;
  endDate: Date;
  createdAt: Date;
  deletedAt: Date | null;
};

export type Tag = {
  id: number;
  name: string;
};

export type CampaignWithTags = Campaign & {
  tags: Tag[];
};

export type CampaignWithStats = CampaignWithTags & {
  impressions: number;
  clicks: number;
  ctr: number;
  dailySpentPercent: number;
  totalSpentPercent: number;
};

export type CampaignTag = {
  campaignId: string;
  tagId: number;
};

export type CachedCampaign = {
  id: string;
  userId: number;
  title: string;
  content: string;
  image: string | null;
  url: string;
  maxCpc: number;
  dailyBudget: number;
  totalBudget: number | null;
  dailySpent: number;
  totalSpent: number;
  lastResetDate: string;
  isHighIntent: boolean;
  status: CampaignStatus;
  startDate: string;
  endDate: string;
  createdAt: string;
  deletedAt: string | null;

  // 태그 정보 (매칭용)
  tags?: string[];

  // 태그별 임베딩 (Worker가 추가)
  embeddingTags?: { [tagName: string]: number[] };

  // 서로 다른 모델의 384차원 벡터를 혼용하지 않기 위한 namespace
  embeddingModelVersion?: string;

  // title + content + tags를 하나의 passage로 표현한 캠페인 semantic vector
  embeddingDocument?: number[];
};

export type CampaignEmbeddingPayload = {
  modelVersion: string;
  document: number[];
  tags: { [tagName: string]: number[] };
};

export type CachedCampaignWithoutSpent = Omit<
  CachedCampaign,
  'dailySpent' | 'totalSpent'
>;

export type CampaignTagVectorSearchOptions = {
  queryEmbedding: number[];
  topL: number;
  isHighIntent: boolean;
  nowTs: number;
};

export type CampaignTagVectorSearchHit = {
  campaignId: string;
  tagName: string;
  distance: number;
  similarity: number;
};

export type CampaignDocumentVectorSearchHit = {
  campaignId: string;
  distance: number;
  similarity: number;
};

export type BudgetReservationCandidate = {
  campaignId: string;
  cpc: number;
};

export type BudgetReservationResult = {
  campaignId: string;
  attemptedCount: number;
};
