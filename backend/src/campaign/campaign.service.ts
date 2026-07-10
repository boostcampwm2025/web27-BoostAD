import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import type { EmbeddingJobData } from 'src/queue/types/queue.type';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { CampaignRepository } from './repository/campaign.repository.interface';
import { CreateCampaignDto } from './dto/create-campaign.dto';
import { UpdateCampaignDto } from './dto/update-campaign.dto';
import { GetCampaignListDto } from './dto/get-campaign-list.dto';
import { CampaignEntity, CampaignStatus } from './entities/campaign.entity';
import { TagEntity } from '../tag/entities/tag.entity';
import type {
  CachedCampaign,
  CachedCampaignWithoutSpent,
  CampaignWithStats,
  CampaignWithTags,
} from './types/campaign.types';
import { AVAILABLE_TAGS } from '../common/constants';
import { UserRepository } from 'src/user/repository/user.repository.interface';
import { CampaignCacheRepository } from './repository/campaign.cache.repository.interface';
// import { CreditHistoryRepository } from 'src/advertiser/repository/credit-history.repository.interface';
import { LogRepository } from 'src/log/repository/log.repository.interface';
import { UserEntity } from 'src/user/entities/user.entity';
import {
  CreditHistoryEntity,
  CreditHistoryType,
} from 'src/advertiser/entities/credit-history.entity';
import { ConfigService } from '@nestjs/config';
import {
  resolveEmbeddingProfile,
  toEmbeddingNamespace,
  type EmbeddingProfile,
} from 'src/rtb/ml/embedding-profile';

@Injectable()
export class CampaignService {
  private readonly logger = new Logger(CampaignService.name);
  private readonly embeddingProfile: EmbeddingProfile;
  private readonly requireDocumentEmbedding: boolean;

  constructor(
    private readonly campaignRepository: CampaignRepository,
    private readonly userRepository: UserRepository,
    private readonly campaignCacheRepository: CampaignCacheRepository,
    private readonly logRepository: LogRepository,
    @InjectDataSource() private readonly dataSource: DataSource,
    @InjectQueue('embedding-queue')
    private readonly embeddingQueue: Queue<EmbeddingJobData>,
    configService: ConfigService
  ) {
    this.embeddingProfile = resolveEmbeddingProfile(
      configService.get<string>('RTB_EMBEDDING_PROFILE')
    );
    this.requireDocumentEmbedding =
      configService.get<string>('RTB_DENSE_RETRIEVAL_MODE') ===
      'semantic_document';
  }

  @OnEvent('ml.model.ready')
  onModelReady(): void {
    this.logger.log('🚀 Campaign 초기 로딩 시작 (ML 모델 준비 완료)');

    // 백그라운드 실행 (await 없음)
    this.loadAllCampaigns().catch((error) => {
      this.logger.error('Campaign 초기 로딩 실패:', error);
    });
  }

  private async loadAllCampaigns(): Promise<void> {
    try {
      const campaigns = await this.campaignRepository.getAll();

      this.logger.log(`📦 총 ${campaigns.length}개 Campaign 로딩 중...`);

      let loaded = 0;
      let embeddingQueued = 0;

      for (const campaign of campaigns) {
        const cached = await this.campaignCacheRepository.findCampaignCacheById(
          campaign.id
        );
        const campaignCache = this.mergeReusableEmbeddings(
          this.convertToCachedCampaignType(campaign),
          cached
        );

        // Redis에 캐싱
        await this.campaignCacheRepository.saveCampaignCacheById(
          campaign.id,
          campaignCache
        );

        loaded++;

        if (!this.hasRequiredEmbeddings(campaignCache)) {
          const queued = await this.enqueueInitialCampaignEmbedding(
            campaign.id
          );
          if (queued) {
            embeddingQueued++;
          }
        }

        // 진행 상황 로깅 (100개당 1번)
        if (loaded % 100 === 0) {
          this.logger.log(
            `📊 Campaign 로딩 진행: ${loaded}/${campaigns.length}`
          );
        }
      }

      this.logger.log(
        `✅ Campaign 로딩 완료: ${loaded}개, 임베딩 큐: ${embeddingQueued}개`
      );
    } catch (error) {
      this.logger.error('Campaign 로딩 중 에러 발생:', error);
      throw error;
    }
  }

  private mergeReusableEmbeddings(
    campaign: CachedCampaign,
    cached: CachedCampaign | null
  ): CachedCampaign {
    if (!campaign.tags || !cached?.embeddingTags) {
      return campaign;
    }

    const sameModel =
      cached.embeddingModelVersion === this.embeddingProfile.modelVersion ||
      (this.embeddingProfile.name === 'legacy_minilm' &&
        !cached.embeddingModelVersion);
    if (!sameModel) {
      return campaign;
    }

    const reusableEmbeddingTags = Object.fromEntries(
      campaign.tags
        .filter(
          (tagName) =>
            cached.embeddingTags?.[tagName]?.length ===
            this.embeddingProfile.dimension
        )
        .map((tagName) => [tagName, cached.embeddingTags![tagName]])
    );

    if (Object.keys(reusableEmbeddingTags).length === 0) {
      return campaign;
    }

    return {
      ...campaign,
      embeddingTags: reusableEmbeddingTags,
      embeddingModelVersion: this.embeddingProfile.modelVersion,
      ...(cached.embeddingDocument?.length === this.embeddingProfile.dimension
        ? { embeddingDocument: cached.embeddingDocument }
        : {}),
    };
  }

  private hasRequiredEmbeddings(campaign: CachedCampaign): boolean {
    const hasTags = Boolean(
      campaign.tags?.length &&
      campaign.tags.every(
        (tagName) =>
          campaign.embeddingTags?.[tagName]?.length ===
          this.embeddingProfile.dimension
      )
    );
    const sameModel =
      campaign.embeddingModelVersion === this.embeddingProfile.modelVersion;
    const hasDocument =
      campaign.embeddingDocument?.length === this.embeddingProfile.dimension;
    return Boolean(
      hasTags && sameModel && (!this.requireDocumentEmbedding || hasDocument)
    );
  }

  private async enqueueInitialCampaignEmbedding(
    campaignId: string
  ): Promise<boolean> {
    const jobId = `campaign-embedding-${toEmbeddingNamespace(
      this.embeddingProfile.modelVersion
    )}-${campaignId}`;
    const existingJob = await this.embeddingQueue.getJob(jobId);

    if (existingJob) {
      const state = await existingJob.getState();
      if (state !== 'failed') {
        return false;
      }
      await existingJob.remove();
    }

    await this.embeddingQueue.add(
      'generate-campaign-embedding',
      { campaignId },
      {
        jobId,
        removeOnComplete: true,
        removeOnFail: false,
        attempts: 3,
      }
    );
    return true;
  }

  // 캠페인 생성 (태그 검증 + 날짜 유효성 체크 + 시작일 기준 상태 설정 + 크레딧 차감)
  async createCampaign(
    userId: number,
    dto: CreateCampaignDto
  ): Promise<CampaignWithTags> {
    await this.validateBudget({
      userId,
      maxCpc: dto.maxCpc,
      dailyBudget: dto.dailyBudget,
      totalBudget: dto.totalBudget,
      checkBalance: true,
    });
    const tagIds = this.validateAndGetTagIds(dto.tags);

    if (new Date(dto.startDate) > new Date(dto.endDate)) {
      throw new BadRequestException('시작일은 종료일보다 앞서야 합니다.');
    }

    // 시작일이 오늘 이하면 ACTIVE, 내일 이상이면 PENDING
    const initialStatus = this.determineInitialStatus(dto.startDate);

    // 트랜잭션으로 캠페인 생성과 크레딧 차감을 원자적으로? 처리
    return await this.dataSource.transaction(async (manager) => {
      // TODO: Datasource가 아닌 InjectRepository로 받은 인스턴스로 쿼리를 날리고있어 트랜잭션에 안묶이므로 수정필요
      const campaign = await this.campaignRepository.create(
        userId,
        dto,
        tagIds,
        initialStatus
      );

      // 2. totalBudget이 있는 경우 크레딧 차감
      if (dto.totalBudget !== null) {
        // 2-1. 사용자 조회 및 잠금
        const userRepo = manager.getRepository(UserEntity);
        const user = await userRepo.findOne({
          where: { id: userId },
          lock: { mode: 'pessimistic_write' },
        });

        if (!user) {
          throw new NotFoundException('사용자를 찾을 수 없습니다');
        }

        // 2-2. 잔액 검증 (이중 체크)
        if (user.balance < dto.totalBudget) {
          throw new BadRequestException(
            '총 예산은 보유 잔액을 초과할 수 없습니다.'
          );
        }

        const newBalance = user.balance - dto.totalBudget;
        user.balance = newBalance;
        await userRepo.save(user);

        const historyRepo = manager.getRepository(CreditHistoryEntity);
        await historyRepo.save({
          userId,
          type: CreditHistoryType.WITHDRAW,
          amount: dto.totalBudget,
          balanceAfter: newBalance,
          campaignId: campaign.id,
        });
      }

      // Redis 캐싱 (write-through 비슷하게)
      await this.campaignCacheRepository.saveCampaignCacheById(
        campaign.id,
        this.convertToCachedCampaignType(campaign)
      );

      await this.embeddingQueue.add('generate-campaign-embedding', {
        campaignId: campaign.id,
      });
      this.logger.log(`캠페인 ${campaign.id} 임베딩 재생성 큐 추가`);

      return campaign;
    });
  }

  // 캠페인 목록 조회 (페이지네이션 + 정렬 + 통계)
  async getCampaignList(userId: number, dto: GetCampaignListDto) {
    const { campaigns, total } = await this.campaignRepository.findByUserId(
      userId,
      dto.status,
      dto.limit,
      dto.offset,
      dto.sortBy,
      dto.order
    );

    // 통계 필드 추가
    const campaignsWithStats =
      await this.addStatsToMultipleCampaigns(campaigns);

    // hasMore 계산
    const hasMore = (dto.offset || 0) + (dto.limit || 3) < total;

    return {
      campaigns: campaignsWithStats,
      total,
      hasMore,
    };
  }

  // 특정 캠페인 조회 (소유권 검증 + 통계)
  async getCampaignById(
    campaignId: string,
    userId: number
  ): Promise<CampaignWithStats> {
    // NOTICE : 이 부분은 RTB에 영향 없는 대쉬보드의 요청이기 때문에 바로 DB로 트랜젝션 굳이 수정할 필요 없을 거 같음
    const campaign = await this.campaignRepository.findOne(campaignId, userId);

    if (!campaign) {
      throw new NotFoundException('캠페인을 찾을 수 없습니다.');
    }

    // 통계 필드 추가
    return this.addStatsToCampaign(campaign);
  }

  // 캠페인 수정 (Redis PAUSED 빠른 변경 → DB 업데이트 → Redis 동기화)
  // 1. Redis 상태만 PAUSED로 빠르게 변경 (비딩 즉시 중단, embeddingTags 보존)
  // 2. DB 업데이트 (Repository 메서드 사용)
  // 3. Redis 전체 동기화 (DB 결과 반영, 요청한 상태로 복원)
  // 4. 태그 변경 시 임베딩 재생성
  async updateCampaign(
    campaignId: string,
    userId: number,
    dto: UpdateCampaignDto
  ): Promise<CampaignWithTags> {
    // const campaign = await this.campaignRepository.findOne(campaignId, userId); A/B campaign
    const cachedCampaign =
      await this.campaignCacheRepository.findCampaignCacheById(campaignId);

    if (!cachedCampaign) {
      // A/B campaign
      await this.updateCampaignStatus(campaignId, CampaignStatus.ACTIVE);
      throw new NotFoundException('캠페인을 찾을 수 없습니다.');
    }

    // Redis 상태만 PAUSED로 빠르게 변경 (비딩 즉시 중단, embeddingTags 보존)
    await this.updateCampaignStatus(campaignId, CampaignStatus.PAUSED);

    // 소유권 검증 추가
    if (cachedCampaign.userId !== userId) {
      // A/B campaign
      await this.updateCampaignStatus(campaignId, CampaignStatus.ACTIVE);
      throw new ForbiddenException('해당 캠페인에 접근할 수 없습니다.');
    }

    if (dto.endDate && dto.endDate <= cachedCampaign.startDate) {
      // A/B campaign
      await this.updateCampaignStatus(campaignId, CampaignStatus.ACTIVE);
      throw new BadRequestException('종료일은 시작일보다 이후여야 합니다.');
    }

    const tagIds = dto.tags ? this.validateAndGetTagIds(dto.tags) : undefined;

    // 시작일이 변경된 경우, 상태 재결정 (PENDING/ACTIVE 상태인 경우에만)
    let newStatus: CampaignStatus | undefined;
    if (
      dto.startDate && // A/B campaign
      (cachedCampaign.status === 'PENDING' ||
        cachedCampaign.status === 'ACTIVE')
    ) {
      newStatus = this.determineInitialStatus(dto.startDate);
    }

    try {
      const maxCpc =
        dto.maxCpc === undefined ? cachedCampaign.maxCpc : dto.maxCpc;
      const dailyBudget =
        dto.dailyBudget === undefined
          ? cachedCampaign.dailyBudget
          : dto.dailyBudget;
      const totalBudget =
        dto.totalBudget === undefined
          ? cachedCampaign.totalBudget
          : dto.totalBudget;

      if (maxCpc === null) {
        throw new BadRequestException('최대 CPC는 null일 수 없습니다.');
      }
      if (dailyBudget === null) {
        throw new BadRequestException('일일 예산은 null일 수 없습니다.');
      }

      await this.validateBudget({
        userId,
        maxCpc,
        dailyBudget,
        totalBudget,
        checkBalance: false,
      });

      // 2. 총 예산 변경에 따른 크레딧 조정 + DB 업데이트 (트랜잭션)
      const updatedCampaign = await this.dataSource.transaction(
        async (manager) => {
          // totalBudget이 변경되는 경우 크레딧 조정
          if (
            dto.totalBudget !== undefined &&
            dto.totalBudget !== cachedCampaign.totalBudget // A/B campaign
          ) {
            const oldBudget = cachedCampaign.totalBudget ?? 0; // A/B campaign
            const newBudget = dto.totalBudget ?? 0;
            const budgetDiff = newBudget - oldBudget;

            // 예산 감액은 허용하지 않음
            if (budgetDiff < 0) {
              throw new BadRequestException(
                '캠페인 예산은 감액할 수 없습니다. 기존 예산보다 크거나 같은 값만 설정할 수 있습니다.'
              );
            }

            // 예산이 증가하는 경우 (추가 차감)
            if (budgetDiff > 0) {
              const userRepo = manager.getRepository(UserEntity);
              const user = await userRepo.findOne({
                where: { id: userId },
                lock: { mode: 'pessimistic_write' },
              });

              if (!user) {
                throw new NotFoundException('사용자를 찾을 수 없습니다');
              }

              // 잔액 검증
              if (user.balance < budgetDiff) {
                throw new BadRequestException(
                  `잔액이 부족합니다. 필요 금액: ${budgetDiff}원, 보유 잔액: ${user.balance}원`
                );
              }

              const newBalance = user.balance - budgetDiff;
              user.balance = newBalance;
              await userRepo.save(user);

              // 크레딧 히스토리 기록 (차감)
              const historyRepo = manager.getRepository(CreditHistoryEntity);
              await historyRepo.save({
                userId,
                type: CreditHistoryType.WITHDRAW,
                amount: budgetDiff,
                balanceAfter: newBalance,
                campaignId: campaignId,
                description: `'${cachedCampaign.title}' 캠페인 예산 추가`, // A/B campaign
              });
            }
          }

          // 캠페인 업데이트 (트랜잭션 매니저 사용)
          const campaignRepo = manager.getRepository(CampaignEntity);
          const campaignToUpdate = await campaignRepo.findOne({
            where: { id: campaignId },
            relations: ['tags'],
          });

          if (!campaignToUpdate) {
            throw new NotFoundException('캠페인을 찾을 수 없습니다.');
          }

          // 업데이트 필드 적용
          if (dto.title !== undefined) campaignToUpdate.title = dto.title;
          if (dto.content !== undefined) campaignToUpdate.content = dto.content;
          if (dto.image !== undefined) campaignToUpdate.image = dto.image;
          if (dto.url !== undefined) campaignToUpdate.url = dto.url;
          if (dto.isHighIntent !== undefined)
            campaignToUpdate.isHighIntent = dto.isHighIntent;
          if (dto.maxCpc !== undefined) campaignToUpdate.maxCpc = dto.maxCpc;
          if (dto.dailyBudget !== undefined)
            campaignToUpdate.dailyBudget = dto.dailyBudget;
          if (dto.totalBudget !== undefined)
            campaignToUpdate.totalBudget = dto.totalBudget;
          if (dto.startDate !== undefined)
            campaignToUpdate.startDate = new Date(dto.startDate);
          if (dto.endDate !== undefined)
            campaignToUpdate.endDate = new Date(dto.endDate);

          // 상태 업데이트
          if (newStatus !== undefined) {
            campaignToUpdate.status = newStatus;
          } else if (dto.status !== undefined) {
            campaignToUpdate.status =
              dto.status === 'ACTIVE'
                ? CampaignStatus.ACTIVE
                : CampaignStatus.PAUSED;
          }

          // 태그 업데이트
          if (tagIds) {
            const tagRepo = manager.getRepository(TagEntity);
            const tags = await tagRepo.findByIds(tagIds);
            campaignToUpdate.tags = tags;
          }

          const savedCampaign = await campaignRepo.save(campaignToUpdate);

          // 변환
          const updatedCampaign: CampaignWithTags = {
            id: savedCampaign.id,
            userId: savedCampaign.userId,
            title: savedCampaign.title,
            content: savedCampaign.content,
            image: savedCampaign.image,
            url: savedCampaign.url,
            maxCpc: savedCampaign.maxCpc,
            dailyBudget: savedCampaign.dailyBudget,
            totalBudget: savedCampaign.totalBudget,
            dailySpent: savedCampaign.dailySpent,
            totalSpent: savedCampaign.totalSpent,
            lastResetDate: savedCampaign.lastResetDate,
            isHighIntent: savedCampaign.isHighIntent,
            status: savedCampaign.status,
            startDate: savedCampaign.startDate,
            endDate: savedCampaign.endDate,
            createdAt: savedCampaign.createdAt,
            deletedAt: savedCampaign.deletedAt,
            tags: savedCampaign.tags.map((tag) => ({
              id: tag.id,
              name: tag.name,
            })),
          };

          return updatedCampaign;
        }
      );

      // 4. semantic passage 구성요소(title/content/tags)가 바뀌면 재생성
      const tagsChanged = Boolean(
        dto.tags &&
        cachedCampaign.tags &&
        !this.areTagsEqual(dto.tags, cachedCampaign.tags)
      );
      const semanticTextChanged = Boolean(dto.title || dto.content);
      if (tagsChanged || semanticTextChanged) {
        await this.campaignCacheRepository.deleteCampaignEmbeddingById(
          campaignId
        );
        await this.embeddingQueue.add('generate-campaign-embedding', {
          campaignId,
        });
        this.logger.log(`캠페인 ${campaignId} 임베딩 재생성 큐 추가`);
      }

      // 3. Redis 전체 동기화 (DB 결과 반영, 요청한 상태로 복원)
      await this.campaignCacheRepository.updateCampaignWithoutCachedById(
        updatedCampaign.id,
        this.convertToCachedCampaignTypeWithoutSpent(updatedCampaign)
      );
      this.logger.log(
        `캠페인 ${campaignId} Redis 최종 동기화 완료 (상태: ${updatedCampaign.status})`
      );

      return updatedCampaign;
    } catch (error) {
      // DB 업데이트 실패 시 Redis 상태 복원
      this.logger.warn(
        `캠페인 ${campaignId} 수정 실패, Redis 상태 복원 시도`,
        error
      );

      // 요청한 상태로 복원 (dto.status가 있으면 그걸로, 없으면 원래 상태)
      const restoreStatus = dto.status
        ? dto.status === 'ACTIVE'
          ? CampaignStatus.ACTIVE
          : CampaignStatus.PAUSED
        : (cachedCampaign.status as CampaignStatus); // A/B campaign

      await this.updateCampaignStatus(campaignId, restoreStatus);

      throw error;
    }
  }

  // 캠페인 클릭 히스토리 조회
  async getClickHistory(
    campaignId: string,
    userId: number,
    limit: number = 5,
    offset: number = 0
  ) {
    // 소유권 검증
    const cachedCampaign =
      await this.campaignCacheRepository.findCampaignCacheById(campaignId);

    if (!cachedCampaign) {
      throw new NotFoundException('캠페인을 찾을 수 없습니다.');
    }

    if (cachedCampaign.userId !== userId) {
      throw new ForbiddenException('해당 캠페인에 접근할 수 없습니다.');
    }

    // LogRepository에서 클릭 히스토리 조회
    const { logs, total } =
      await this.logRepository.getClickHistoryByCampaignId(
        campaignId,
        limit,
        offset
      );

    return {
      logs,
      total,
      hasMore: offset + limit < total,
    };
  }

  // 캠페인 삭제 (소프트 삭제, 소유권 검증)
  async deleteCampaign(campaignId: string, userId: number): Promise<void> {
    // const campaign = await this.campaignRepository.findOne(campaignId, userId); A/B campaign
    const cachedCampaign =
      await this.campaignCacheRepository.findCampaignCacheById(campaignId);

    if (!cachedCampaign) {
      // A/B campaign
      throw new NotFoundException('캠페인을 찾을 수 없습니다.');
    }

    await this.updateCampaignStatus(campaignId, CampaignStatus.PAUSED);

    // 소유권 검증 추가
    if (cachedCampaign.userId !== userId) {
      await this.updateCampaignStatus(campaignId, CampaignStatus.ACTIVE);
      throw new ForbiddenException('해당 캠페인에 접근할 수 없습니다.');
    }

    // Redis 먼저 삭제 (RTB 비딩 중단)
    await this.campaignCacheRepository.deleteCampaignCacheById(campaignId);

    // 트랜잭션으로 DB 삭제 + 예산 환불 처리
    await this.dataSource.transaction(async (manager) => {
      // DB 삭제 (Soft Delete)
      await this.campaignRepository.delete(campaignId);

      // 남은 예산 환불 처리 (totalBudget이 설정된 경우만)
      if (
        cachedCampaign.totalBudget !== null &&
        cachedCampaign.totalBudget > 0
      ) {
        const remainingBudget =
          cachedCampaign.totalBudget - cachedCampaign.totalSpent;

        // 남은 예산이 있는 경우에만 환불
        if (remainingBudget > 0) {
          const userRepo = manager.getRepository(UserEntity);
          const user = await userRepo.findOne({
            where: { id: userId },
            lock: { mode: 'pessimistic_write' },
          });

          if (!user) {
            throw new NotFoundException('사용자를 찾을 수 없습니다');
          }

          // 잔액 환불
          const newBalance = user.balance + remainingBudget;
          user.balance = newBalance;
          await userRepo.save(user);

          // 크레딧 히스토리 기록 (환불)
          const historyRepo = manager.getRepository(CreditHistoryEntity);
          await historyRepo.save({
            userId,
            type: CreditHistoryType.CHARGE,
            amount: remainingBudget,
            balanceAfter: newBalance,
            campaignId: campaignId,
            description: `'${cachedCampaign.title}' 캠페인 삭제 - 남은 예산 환불`,
          });

          this.logger.log(
            `캠페인 ${campaignId} 삭제 - 남은 예산 ${remainingBudget}원 환불 완료`
          );
        }
      }
    });
  }

  // ============================================================================
  // 모듈화 된 함수들
  // ============================================================================
  private async validateBudget({
    userId,
    maxCpc,
    dailyBudget,
    totalBudget,
    checkBalance,
  }: {
    userId: number;
    maxCpc: number;
    dailyBudget: number;
    totalBudget: number | null;
    checkBalance?: boolean;
  }): Promise<void> {
    if (maxCpc > dailyBudget) {
      throw new BadRequestException('CPC값은 일 예산을 초과할 수 없습니다.');
    }

    if (totalBudget !== null && dailyBudget > totalBudget) {
      throw new BadRequestException('일 예산은 총 예산을 초과할 수 없습니다.');
    }

    if (checkBalance && totalBudget !== null) {
      const balance = await this.userRepository.getBalanceById(userId);

      if (balance == null) {
        throw new NotFoundException();
      }

      if (totalBudget > balance) {
        throw new BadRequestException(
          '총 예산은 보유 잔액을 초과할 수 없습니다.'
        );
      }
    }
  }
  // 시작일 기준 초기 상태 결정
  private determineInitialStatus(
    startDate: string
  ): CampaignStatus.ACTIVE | CampaignStatus.PENDING {
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const start = new Date(startDate);
    start.setHours(0, 0, 0, 0);

    return start <= today ? CampaignStatus.ACTIVE : CampaignStatus.PENDING;
  }

  // 태그 이름 배열을 태그 ID 배열로 변환
  // TODO: tag부분도 Redis캐싱을 필요할듯
  private validateAndGetTagIds(tagNames: string[]): number[] {
    const tagIds: number[] = [];

    for (const name of tagNames) {
      const tag = AVAILABLE_TAGS.find((t) => t.name === name);
      if (!tag) {
        throw new BadRequestException(`존재하지 않는 태그입니다: ${name}`);
      }
      tagIds.push(tag.id);
    }

    return tagIds;
  }
  // 단일 캠페인에 통계 필드 추가
  private async addStatsToCampaign(
    campaign: CampaignWithTags
  ): Promise<CampaignWithStats> {
    const viewCounts = await this.campaignRepository.getViewCountsByCampaignIds(
      [campaign.id]
    );
    const clickCounts =
      await this.campaignRepository.getClickCountsByCampaignIds([campaign.id]);

    const impressions = viewCounts.get(campaign.id) || 0;
    const clicks = clickCounts.get(campaign.id) || 0;

    // DB Campaign 테이블의 dailySpent, totalSpent 사용 (Cron Job으로 동기화됨)
    const dailySpent = campaign.dailySpent;
    const totalSpent = campaign.totalSpent;

    return {
      ...campaign,
      dailySpent,
      totalSpent,
      impressions,
      clicks,
      ctr: this.calculateCTR(clicks, impressions),
      dailySpentPercent: this.calculatePercent(
        dailySpent,
        campaign.dailyBudget
      ),
      totalSpentPercent: this.calculatePercent(
        totalSpent,
        campaign.totalBudget
      ),
    };
  }

  // CTR 계산 (소수점 2자리)
  private calculateCTR(clicks: number, impressions: number): number {
    if (impressions === 0) return 0;
    return parseFloat(((clicks / impressions) * 100).toFixed(2));
  }

  // 퍼센트 계산 (소수점 2자리)
  private calculatePercent(spent: number, budget: number | null): number {
    if (budget === null || budget === 0) return 0;
    return parseFloat(((spent / budget) * 100).toFixed(2));
  }

  // 여러 캠페인에 통계 필드 추가
  private async addStatsToMultipleCampaigns(
    campaigns: CampaignWithTags[]
  ): Promise<CampaignWithStats[]> {
    if (campaigns.length === 0) {
      return [];
    }

    const campaignIds = campaigns.map((c) => c.id);

    // 일괄 집계
    const viewCounts =
      await this.campaignRepository.getViewCountsByCampaignIds(campaignIds);
    const clickCounts =
      await this.campaignRepository.getClickCountsByCampaignIds(campaignIds);

    // 각 캠페인에 통계 추가
    return campaigns.map((campaign) => {
      const impressions = viewCounts.get(campaign.id) || 0;
      const clicks = clickCounts.get(campaign.id) || 0;

      // DB Campaign 테이블의 dailySpent, totalSpent 사용
      const dailySpent = campaign.dailySpent;
      const totalSpent = campaign.totalSpent;

      return {
        ...campaign,
        dailySpent,
        totalSpent,
        impressions,
        clicks,
        ctr: this.calculateCTR(clicks, impressions),
        dailySpentPercent: this.calculatePercent(
          dailySpent,
          campaign.dailyBudget
        ),
        totalSpentPercent: this.calculatePercent(
          totalSpent,
          campaign.totalBudget
        ),
      };
    });
  }

  private convertToCachedCampaignType(
    campaign: CampaignWithTags
  ): CachedCampaign {
    return {
      id: campaign.id,
      userId: campaign.userId,
      title: campaign.title,
      content: campaign.content,
      image: campaign.image,
      url: campaign.url,
      maxCpc: campaign.maxCpc,
      dailyBudget: campaign.dailyBudget,
      totalBudget: campaign.totalBudget ?? null,
      dailySpent: campaign.dailySpent,
      totalSpent: campaign.totalSpent,
      lastResetDate: campaign.lastResetDate.toISOString(),
      isHighIntent: campaign.isHighIntent,
      status: campaign.status,
      startDate: campaign.startDate.toISOString(),
      endDate: campaign.endDate.toISOString(),
      createdAt: campaign.createdAt.toISOString(),
      deletedAt: campaign.deletedAt ? campaign.deletedAt.toISOString() : null,

      // 태그 이름 배열 추가
      tags: campaign.tags.map((t) => t.name),

      // embeddingTags는 Worker가 나중에 추가
    };
  }

  private convertToCachedCampaignTypeWithoutSpent(
    campaign: CampaignWithTags
  ): CachedCampaignWithoutSpent {
    return {
      id: campaign.id,
      userId: campaign.userId,
      title: campaign.title,
      content: campaign.content,
      image: campaign.image,
      url: campaign.url,
      maxCpc: campaign.maxCpc,
      dailyBudget: campaign.dailyBudget,
      totalBudget: campaign.totalBudget ?? null,
      lastResetDate: campaign.lastResetDate.toISOString(),
      isHighIntent: campaign.isHighIntent,
      status: campaign.status,
      startDate: campaign.startDate.toISOString(),
      endDate: campaign.endDate.toISOString(),
      createdAt: campaign.createdAt.toISOString(),
      deletedAt: campaign.deletedAt ? campaign.deletedAt.toISOString() : null,

      // 태그 이름 배열 추가
      tags: campaign.tags.map((t) => t.name),
    };
  }

  private async updateCampaignStatus(
    campaignId: string,
    status: CampaignStatus
  ) {
    await this.campaignCacheRepository.updateCampaignStatus(campaignId, status);
    this.logger.log(`캠페인 ${campaignId} Redis 상태 → ${status}`);
  }

  private areTagsEqual(dtoTags: string[], redisTags: string[]): boolean {
    // 1. 개수 비교
    if (dtoTags.length !== redisTags.length) {
      return false;
    }

    // 2. Set을 이용한 비교
    const dtoSet = new Set(dtoTags);
    return redisTags.every((tag) => dtoSet.has(tag));
  }
}
