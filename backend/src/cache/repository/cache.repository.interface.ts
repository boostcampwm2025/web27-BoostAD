import { AuctionData } from '../types/auction-data.type';
import { StoredOAuthState } from '../../auth/auth.service';

export interface RollbackInfo {
  campaignId: string;
  cost: number;
  createdAt: string;
}

export abstract class CacheRepository {
  // Auction 관련 메서드
  abstract setAuctionData(
    auctionId: string,
    auctionData: AuctionData,
    ttl?: number
  ): Promise<void>;
  abstract getAuctionData(auctionId: string): Promise<AuctionData | undefined>;
  abstract deleteAuctionData(auctionId: string): Promise<void>;

  // OAuth State 관련 메서드
  abstract setOAuthState(
    state: string,
    data: StoredOAuthState,
    ttl: number
  ): Promise<void>;
  abstract getOAuthState(state: string): Promise<StoredOAuthState | undefined>;
  abstract deleteOAuthState(state: string): Promise<void>;

  abstract acquireViewIdempotencyKey(
    postUrl: string,
    visitorId: string,
    isHighIntent: boolean,
    ttlMs?: number
  ): Promise<
    | { status: 'acquired' }
    | { status: 'exists'; viewId: number }
    | { status: 'locked' }
  >;

  abstract setViewIdempotencyKey(
    postUrl: string,
    visitorId: string,
    isHighIntent: boolean,
    viewId: number,
    ttlMs?: number
  ): Promise<void>;

  abstract getViewIdByIdempotencyKey(
    postUrl: string,
    visitorId: string,
    isHighIntent: boolean
  ): Promise<number | null>;

  abstract setClickIdempotencyKey(
    viewId: number,
    ttlMs?: number
  ): Promise<boolean>;

  // Rollback 정보 관련 메서드
  abstract setRollbackInfo(
    viewId: number,
    rollbackInfo: RollbackInfo,
    ttl?: number
  ): Promise<void>;

  abstract getRollbackInfo(viewId: number): Promise<RollbackInfo | null>;

  abstract deleteRollbackInfo(viewId: number): Promise<void>;

  // Rollback 백업 관련 메서드 (TTL 없음 - Worker용)
  abstract setRollbackBackup(
    viewId: number,
    rollbackInfo: RollbackInfo,
    ttl?: number
  ): Promise<void>;

  abstract getRollbackBackup(viewId: number): Promise<RollbackInfo | null>;

  abstract deleteRollbackBackup(viewId: number): Promise<void>;
}
