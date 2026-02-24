import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { BidLogRepository } from './bid-log.repository.interface';
import { BidLogEntity } from '../entities/bid-log.entity';
import { BidLog, BidStatus } from '../bid-log.types';

@Injectable()
export class TypeOrmBidLogRepository extends BidLogRepository {
  constructor(
    @InjectRepository(BidLogEntity)
    private readonly repository: Repository<BidLogEntity>
  ) {
    super();
  }

  async findById(id: number): Promise<BidLog | null> {
    const log = await this.repository.findOne({ where: { id } });
    return log ?? null;
  }

  async save(bidLog: BidLog): Promise<void> {
    await this.repository.save(bidLog);
  }

  async saveMany(bidLogs: BidLog[]): Promise<BidLog[]> {
    const result = await this.repository.save(bidLogs);
    return result;
  }

  async findByAuctionId(auctionId: string): Promise<BidLog[]> {
    const logs = await this.repository.find({
      where: { auctionId },
    });
    return logs;
  }

  async findByCampaignId(campaignId: string): Promise<BidLog[]> {
    const logs = await this.repository.find({
      where: { campaignId },
    });
    return logs;
  }

  async findWinAmountByAuctionId(auctionId: string): Promise<number | null> {
    const winLog = await this.repository.findOne({
      where: { auctionId, status: BidStatus.WIN as BidStatus },
    });
    return winLog ? winLog.bidPrice : null;
  }

  async count(): Promise<number> {
    return await this.repository.count();
  }

  async getAll(): Promise<BidLog[]> {
    const logs = await this.repository.find();
    return logs;
  }

  async findByUserId(
    userId: number,
    limit: number = 10,
    offset: number = 0,
    sortBy: 'createdAt' = 'createdAt',
    order: 'asc' | 'desc' = 'desc',
    startDate?: string,
    endDate?: string,
    campaignIds?: string[]
  ): Promise<BidLog[]> {
    // DB 레벨에서 JOIN, 필터링, 정렬, 페이지네이션을 한 번에 처리
    // 외래키 제약조건이 제거되었으므로 명시적인 JOIN 조건 사용
    const queryBuilder = this.repository
      .createQueryBuilder('bidLog')
      .innerJoin('Campaign', 'campaign', 'bidLog.campaign_id = campaign.id')
      .where('campaign.userId = :userId', { userId });

    if (campaignIds && campaignIds.length > 0) {
      queryBuilder.andWhere('bidLog.campaign_id IN (:...campaignIds)', {
        campaignIds,
      });
    }

    if (startDate) {
      queryBuilder.andWhere('bidLog.createdAt >= :startDate', {
        startDate: new Date(startDate),
      });
    }
    if (endDate) {
      queryBuilder.andWhere('bidLog.createdAt <= :endDate', {
        endDate: new Date(endDate),
      });
    }

    const logs = await queryBuilder
      .orderBy(`bidLog.${sortBy}`, order.toUpperCase() as 'ASC' | 'DESC')
      .skip(offset)
      .take(limit)
      .getMany();

    return logs;
  }

  async countByUserId(
    userId: number,
    startDate?: string,
    endDate?: string,
    campaignIds?: string[]
  ): Promise<number> {
    const queryBuilder = this.repository
      .createQueryBuilder('bidLog')
      .innerJoin('Campaign', 'campaign', 'bidLog.campaign_id = campaign.id')
      .where('campaign.userId = :userId', { userId });

    if (campaignIds && campaignIds.length > 0) {
      queryBuilder.andWhere('bidLog.campaign_id IN (:...campaignIds)', {
        campaignIds,
      });
    }

    if (startDate) {
      queryBuilder.andWhere('bidLog.createdAt >= :startDate', {
        startDate: new Date(startDate),
      });
    }
    if (endDate) {
      queryBuilder.andWhere('bidLog.createdAt <= :endDate', {
        endDate: new Date(endDate),
      });
    }

    return await queryBuilder.getCount();
  }
}
