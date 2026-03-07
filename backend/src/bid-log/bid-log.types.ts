export enum BidStatus {
  WIN = 'WIN',
  LOSS = 'LOSS',
}

export interface BidLog {
  id?: number;
  auctionId: string;
  campaignId: string;
  blogId: number;
  status: BidStatus;
  bidPrice: number;
  reason: string | null;
  createdAt?: Date;
  isHighIntent: boolean;
  behaviorScore: number | null;
  postUrl?: string | null;
}

export interface BidCreatedEventPayload {
  log: BidLog;
  userId: number;
  campaignTitle: string;
  blogKey: string;
  blogName: string;
  winAmount: number | null;
}

export interface BidCreatedPubSubMessage {
  publishedAt?: string;
  events: BidCreatedEventPayload[];
}
