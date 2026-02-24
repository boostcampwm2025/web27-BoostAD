import { BidLog } from '../bid-log.types';

export abstract class BidLogRepository {
  // 단일 입찰 로그 조회 (by ID)
  abstract findById(id: number): Promise<BidLog | null>;

  // 단일 입찰 로그 저장
  abstract save(bidLog: BidLog): Promise<void>;

  // 여러 입찰 로그들을 일괄 저장
  abstract saveMany(bidLogs: BidLog[]): Promise<BidLog[]>;

  // 옥션 ID로 입찰 로그 조회
  abstract findByAuctionId(auctionId: string): Promise<BidLog[]>;

  // 캠페인 ID로 입찰 로그 조회
  abstract findByCampaignId(campaignId: string): Promise<BidLog[]>;

  // 특정 옥션의 낙찰가 조회
  abstract findWinAmountByAuctionId(auctionId: string): Promise<number | null>;

  // 전체 입찰 로그 수 조회
  abstract count(): Promise<number>;

  // 모든 입찰 로그 목록 조회
  abstract getAll(): Promise<BidLog[]>;

  // userId에 해당하는 캠페인의 입찰 로그 조회 (페이지네이션, 정렬, 기간 필터 포함)
  abstract findByUserId(
    userId: number,
    limit?: number,
    offset?: number,
    sortBy?: 'createdAt',
    order?: 'asc' | 'desc',
    startDate?: string,
    endDate?: string,
    campaignIds?: string[]
  ): Promise<BidLog[]>;

  // userId에 해당하는 캠페인의 입찰 로그 총 개수 조회 (기간 필터 포함)
  abstract countByUserId(
    userId: number,
    startDate?: string,
    endDate?: string,
    campaignIds?: string[]
  ): Promise<number>;
}
