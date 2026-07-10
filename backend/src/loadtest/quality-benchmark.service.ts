import { createHash, randomUUID } from 'node:crypto';
import {
  ConflictException,
  ForbiddenException,
  Injectable,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { CampaignCacheRepository } from 'src/campaign/repository/campaign.cache.repository.interface';
import type { CachedCampaign } from 'src/campaign/types/campaign.types';
import { ContextEmbeddingService } from 'src/rtb/context/context-embedding.service';
import { Matcher } from 'src/rtb/matchers/matcher.interface';
import { MLEngine } from 'src/rtb/ml/mlEngine.interface';
import type { DecisionContext } from 'src/rtb/types/decision.types';
import type {
  ExtractQualityRankingsDto,
  LoadQualityCampaignsDto,
  QualityCampaignDto,
  QualityContentDto,
} from './dto/quality-benchmark.dto';
import { buildCampaignDocumentText } from 'src/rtb/ml/embedding-text';

type QualitySession = {
  sessionId: string;
  datasetVersion: string;
  qualityCampaignIds: ReadonlySet<string>;
  previousCampaigns: CachedCampaign[];
};

type QualityRanking = {
  contentId: string;
  candidates: Array<{
    campaignKey: string;
    score: number;
    similarity: number;
  }>;
};

@Injectable()
export class QualityBenchmarkService {
  private activeSession: QualitySession | null = null;
  private operationInProgress = false;

  constructor(
    private readonly configService: ConfigService,
    private readonly campaignCacheRepository: CampaignCacheRepository,
    private readonly mlEngine: MLEngine,
    private readonly contextEmbeddingService: ContextEmbeddingService,
    private readonly matcher: Matcher
  ) {}

  async loadCampaigns(
    dto: LoadQualityCampaignsDto,
    providedToken?: string
  ): Promise<{
    sessionId: string;
    datasetVersion: string;
    loadedCampaignCount: number;
    previousCampaignCount: number;
    uniqueEmbeddedTagCount: number;
    indexedTagVectorCount: number;
    indexedDocumentVectorCount: number;
    runtime: {
      embeddingProfile: string;
      modelId: string;
      modelVersion: string;
      embeddingDimension: number;
      denseRetrievalMode: string;
      documentSimilarityThreshold: string;
      annTopL: string;
      annTopM: string;
      campaignSource: string;
    };
  }> {
    this.assertAllowed(providedToken);
    this.assertRuntimeReady();
    this.assertIdle();
    if (this.activeSession) {
      throw new ConflictException(
        '활성 quality session을 먼저 restore해야 합니다.'
      );
    }
    this.assertCampaignContract(dto.campaigns);

    this.operationInProgress = true;
    const previousCampaigns =
      await this.campaignCacheRepository.getAllCampaigns({
        allowStale: false,
      });
    try {
      const embeddings = await this.buildTagEmbeddings(dto.campaigns);
      const qualityCampaigns: CachedCampaign[] = [];
      for (const campaign of dto.campaigns) {
        const document = await this.mlEngine.getEmbedding(
          buildCampaignDocumentText(campaign),
          'passage'
        );
        qualityCampaigns.push(
          this.toCachedCampaign(campaign, embeddings, document)
        );
      }
      await this.replaceServingCampaigns(previousCampaigns, qualityCampaigns);
      const { indexedTagVectorCount, indexedDocumentVectorCount } =
        await this.waitForAnnReady(qualityCampaigns);

      const sessionId = randomUUID();
      this.activeSession = {
        sessionId,
        datasetVersion: dto.datasetVersion,
        qualityCampaignIds: new Set(
          qualityCampaigns.map((campaign) => campaign.id)
        ),
        previousCampaigns,
      };
      return {
        sessionId,
        datasetVersion: dto.datasetVersion,
        loadedCampaignCount: qualityCampaigns.length,
        previousCampaignCount: previousCampaigns.length,
        uniqueEmbeddedTagCount: embeddings.size,
        indexedTagVectorCount,
        indexedDocumentVectorCount,
        runtime: this.runtimeMetadata(),
      };
    } catch (error) {
      await this.restoreAfterFailedLoad(previousCampaigns);
      throw error;
    } finally {
      this.operationInProgress = false;
    }
  }

  async extractRankings(
    dto: ExtractQualityRankingsDto,
    providedToken?: string
  ): Promise<{
    sessionId: string;
    datasetVersion: string;
    retrievalMode: 'dense_only';
    topK: number;
    rankings: QualityRanking[];
    reserveCalled: false;
    budgetMutationCount: 0;
  }> {
    this.assertAllowed(providedToken);
    this.assertRuntimeReady();
    this.assertIdle();
    const session = this.assertSession(dto.sessionId, dto.datasetVersion);
    const topK = dto.topK ?? 10;

    this.operationInProgress = true;
    try {
      const beforeBudget = await this.readBudgetState(
        session.qualityCampaignIds
      );
      const rankings: QualityRanking[] = [];
      for (const content of dto.contents) {
        const contextId = await this.prepareReadyContext(content);
        const context: DecisionContext = {
          blogKey: 'phase4-quality',
          blogId: 0,
          blogName: 'Phase 4 Quality Benchmark',
          tags: content.tags,
          contextId,
          postUrl: `https://quality.boostad.local/content/${content.contentId}`,
          behaviorScore: 0,
          isHighIntent: false,
        };
        const candidates = await this.matcher.findCandidatesByTags(context);
        const foreignCandidates = candidates.filter(
          (candidate) => !session.qualityCampaignIds.has(candidate.id)
        );
        if (foreignCandidates.length > 0) {
          throw new ConflictException(
            `quality campaign 격리가 깨졌습니다: ${foreignCandidates
              .slice(0, 3)
              .map((candidate) => candidate.id)
              .join(', ')}`
          );
        }

        rankings.push({
          contentId: content.contentId,
          candidates: [...candidates]
            .sort((left, right) => {
              if (right.score !== left.score) return right.score - left.score;
              if (right.maxCpc !== left.maxCpc) {
                return right.maxCpc - left.maxCpc;
              }
              return left.id.localeCompare(right.id);
            })
            .slice(0, topK)
            .map((candidate) => ({
              campaignKey: candidate.id,
              score: candidate.score,
              similarity: candidate.similarity,
            })),
        });
      }
      const afterBudget = await this.readBudgetState(
        session.qualityCampaignIds
      );
      const mutations = [...beforeBudget.entries()].filter(
        ([campaignId, before]) => {
          const after = afterBudget.get(campaignId);
          return (
            !after ||
            before.dailySpent !== after.dailySpent ||
            before.totalSpent !== after.totalSpent
          );
        }
      );
      if (mutations.length > 0) {
        throw new ConflictException(
          `reserve-free 계약이 깨졌습니다: budget mutation ${mutations.length}개`
        );
      }

      return {
        sessionId: session.sessionId,
        datasetVersion: session.datasetVersion,
        retrievalMode: dto.retrievalMode ?? 'dense_only',
        topK,
        rankings,
        reserveCalled: false,
        budgetMutationCount: 0,
      };
    } finally {
      this.operationInProgress = false;
    }
  }

  async restoreCampaigns(
    sessionId: string,
    providedToken?: string
  ): Promise<{
    sessionId: string;
    restoredCampaignCount: number;
    removedQualityCampaignCount: number;
  }> {
    this.assertAllowed(providedToken);
    this.assertIdle();
    const session = this.assertSession(sessionId);

    this.operationInProgress = true;
    try {
      const qualityCampaigns =
        await this.campaignCacheRepository.getAllCampaigns({
          allowStale: false,
        });
      await this.replaceServingCampaigns(
        qualityCampaigns,
        session.previousCampaigns
      );
      this.activeSession = null;
      this.contextEmbeddingService.clearReadyL1();
      return {
        sessionId,
        restoredCampaignCount: session.previousCampaigns.length,
        removedQualityCampaignCount: qualityCampaigns.length,
      };
    } finally {
      this.operationInProgress = false;
    }
  }

  private assertAllowed(providedToken?: string): void {
    if (this.configService.get<string>('LOADTEST_RESET_ENABLED') !== 'true') {
      throw new ForbiddenException(
        'LOADTEST_RESET_ENABLED=true인 환경에서만 quality benchmark를 실행할 수 있습니다.'
      );
    }
    const expectedToken = this.configService.get<string>(
      'LOADTEST_RESET_TOKEN'
    );
    if (!expectedToken) {
      throw new ServiceUnavailableException(
        'LOADTEST_RESET_TOKEN이 필요합니다.'
      );
    }
    if (!providedToken || providedToken !== expectedToken) {
      throw new UnauthorizedException(
        '유효한 loadtest reset token이 필요합니다.'
      );
    }
  }

  private assertRuntimeReady(): void {
    if (!this.mlEngine.isReady()) {
      throw new ServiceUnavailableException(
        'Embedding model이 준비되지 않았습니다.'
      );
    }
    const localSnapshot =
      this.configService.get<string>('RTB_CAMPAIGN_SOURCE') ===
        'local_snapshot' ||
      this.configService.get<string>('RTB_MATCHER_LOCAL_SNAPSHOT_ENABLED') ===
        'true';
    if (
      this.configService.get<string>('RTB_MATCHER_ANN_ENABLED') !== 'true' ||
      this.configService.get<string>('RTB_CONTEXT_DECISION_ENABLED') !==
        'true' ||
      !localSnapshot
    ) {
      throw new ServiceUnavailableException(
        'quality benchmark에는 ANN, context decision, local snapshot이 모두 필요합니다.'
      );
    }
  }

  private assertIdle(): void {
    if (this.operationInProgress) {
      throw new ConflictException(
        '다른 quality benchmark 작업이 진행 중입니다.'
      );
    }
  }

  private runtimeMetadata() {
    return {
      embeddingProfile: this.mlEngine.getProfileName(),
      modelId: this.mlEngine.getModelId(),
      modelVersion: this.mlEngine.getModelVersion(),
      embeddingDimension: this.mlEngine.getEmbeddingDimension(),
      denseRetrievalMode: this.configService.get<string>(
        'RTB_DENSE_RETRIEVAL_MODE',
        'legacy_tag'
      ),
      documentSimilarityThreshold: this.configService.get<string>(
        'RTB_MATCHER_DOCUMENT_SIMILARITY_THRESHOLD',
        '0.3'
      ),
      annTopL: this.configService.get<string>('RTB_MATCHER_ANN_TOP_L', '200'),
      annTopM: this.configService.get<string>('RTB_MATCHER_ANN_TOP_M', '30'),
      campaignSource: this.configService.get<string>(
        'RTB_CAMPAIGN_SOURCE',
        'redis_json'
      ),
    };
  }

  private assertSession(
    sessionId: string,
    datasetVersion?: string
  ): QualitySession {
    const session = this.activeSession;
    if (!session || session.sessionId !== sessionId) {
      throw new ConflictException('유효한 active quality session이 아닙니다.');
    }
    if (datasetVersion && session.datasetVersion !== datasetVersion) {
      throw new ConflictException(
        'quality dataset version이 일치하지 않습니다.'
      );
    }
    return session;
  }

  private assertCampaignContract(campaigns: QualityCampaignDto[]): void {
    const ids = new Set<string>();
    for (const campaign of campaigns) {
      if (!/^q4-[a-z0-9-]+$/.test(campaign.campaignKey)) {
        throw new ConflictException(
          `quality campaignKey 형식이 잘못됐습니다: ${campaign.campaignKey}`
        );
      }
      if (ids.has(campaign.campaignKey)) {
        throw new ConflictException(
          `quality campaignKey가 중복됐습니다: ${campaign.campaignKey}`
        );
      }
      ids.add(campaign.campaignKey);
    }
  }

  private async buildTagEmbeddings(
    campaigns: QualityCampaignDto[]
  ): Promise<Map<string, number[]>> {
    const normalizedTags = [
      ...new Set(
        campaigns.flatMap((campaign) =>
          campaign.tags.map((tag) => this.normalizeText(tag)).filter(Boolean)
        )
      ),
    ].sort();
    const embeddings = new Map<string, number[]>();
    for (const tag of normalizedTags) {
      const embedding = await this.mlEngine.getEmbedding(tag, 'passage');
      if (
        embedding.length !== this.mlEngine.getEmbeddingDimension() ||
        embedding.some((value) => !Number.isFinite(value))
      ) {
        throw new ServiceUnavailableException(
          `quality tag embedding contract가 잘못됐습니다: ${tag}`
        );
      }
      embeddings.set(tag, embedding);
    }
    return embeddings;
  }

  private toCachedCampaign(
    input: QualityCampaignDto,
    embeddings: ReadonlyMap<string, number[]>,
    document: number[]
  ): CachedCampaign {
    const tags = [
      ...new Set(
        input.tags.map((tag) => this.normalizeText(tag)).filter(Boolean)
      ),
    ];
    const now = new Date();
    const startDate = new Date(now.getTime() - 24 * 60 * 60 * 1_000);
    const endDate = new Date(now.getTime() + 365 * 24 * 60 * 60 * 1_000);
    return {
      id: input.campaignKey,
      userId: 0,
      title: input.title,
      content: input.content,
      image: null,
      url: `https://quality.boostad.local/campaign/${input.campaignKey}`,
      maxCpc: 100,
      dailyBudget: 1_000_000_000,
      totalBudget: 2_000_000_000,
      dailySpent: 0,
      totalSpent: 0,
      lastResetDate: now.toISOString(),
      isHighIntent: false,
      status: 'ACTIVE',
      startDate: startDate.toISOString(),
      endDate: endDate.toISOString(),
      createdAt: now.toISOString(),
      deletedAt: null,
      tags,
      embeddingModelVersion: this.mlEngine.getModelVersion(),
      embeddingDocument: document,
      embeddingTags: Object.fromEntries(
        tags.map((tag) => {
          const embedding = embeddings.get(tag);
          if (!embedding) {
            throw new Error(`quality tag embedding이 없습니다: ${tag}`);
          }
          return [tag, embedding];
        })
      ),
    };
  }

  private async prepareReadyContext(
    content: QualityContentDto
  ): Promise<string> {
    const title = this.normalizeText(content.title);
    const body = this.normalizeText(content.body).slice(
      0,
      this.getPositiveInt('RTB_CONTEXT_MAX_BODY_CHARS', 8_000)
    );
    const tags = [
      ...new Set(
        content.tags.map((tag) => this.normalizeText(tag)).filter(Boolean)
      ),
    ].sort();
    const serialized = JSON.stringify({ title, body, tags });
    const embeddingText = [title, body, tags.join(' ')]
      .filter(Boolean)
      .join('\n');
    const contentHash = createHash('sha256').update(serialized).digest('hex');
    const contextId = `ctx_${contentHash}`;
    const modelVersion = this.mlEngine.getModelVersion();
    const embedding = await this.mlEngine.getEmbedding(embeddingText, 'query');
    await this.contextEmbeddingService.completeJob(
      {
        contextId,
        contentHash,
        modelVersion,
        text: embeddingText,
      },
      embedding
    );
    return contextId;
  }

  private async readBudgetState(
    campaignIds: ReadonlySet<string>
  ): Promise<Map<string, { dailySpent: number; totalSpent: number }>> {
    const campaigns =
      await this.campaignCacheRepository.findCampaignCachesByIds([
        ...campaignIds,
      ]);
    if (campaigns.length !== campaignIds.size) {
      throw new ConflictException(
        `quality campaign budget snapshot이 불완전합니다: ${campaigns.length}/${campaignIds.size}`
      );
    }
    return new Map(
      campaigns.map((campaign) => [
        campaign.id,
        {
          dailySpent: campaign.dailySpent,
          totalSpent: campaign.totalSpent,
        },
      ])
    );
  }

  private async waitForAnnReady(campaigns: CachedCampaign[]): Promise<{
    indexedTagVectorCount: number;
    indexedDocumentVectorCount: number;
  }> {
    const expectedTagVectorCount = campaigns.reduce(
      (sum, campaign) => sum + Object.keys(campaign.embeddingTags ?? {}).length,
      0
    );
    const queryEmbedding = Object.values(campaigns[0]?.embeddingTags ?? {})[0];
    const documentQueryEmbedding = campaigns[0]?.embeddingDocument;
    if (
      !queryEmbedding ||
      !documentQueryEmbedding ||
      expectedTagVectorCount === 0
    ) {
      throw new ServiceUnavailableException(
        'quality campaign ANN readiness를 확인할 embedding이 없습니다.'
      );
    }

    const qualityIds = new Set(campaigns.map((campaign) => campaign.id));
    const maxAttempts = this.getPositiveInt(
      'LOADTEST_QUALITY_INDEX_READY_ATTEMPTS',
      20
    );
    const intervalMs = this.getPositiveInt(
      'LOADTEST_QUALITY_INDEX_READY_INTERVAL_MS',
      50
    );
    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      const hits = await this.campaignCacheRepository.searchCampaignTagVectors({
        queryEmbedding,
        topL: expectedTagVectorCount,
        isHighIntent: false,
        nowTs: Date.now(),
      });
      const indexedQualityHits = hits.filter((hit) =>
        qualityIds.has(hit.campaignId)
      ).length;
      const documentHits =
        await this.campaignCacheRepository.searchCampaignDocumentVectors({
          queryEmbedding: documentQueryEmbedding,
          topL: campaigns.length,
          isHighIntent: false,
          nowTs: Date.now(),
        });
      const indexedQualityDocuments = documentHits.filter((hit) =>
        qualityIds.has(hit.campaignId)
      ).length;
      if (
        indexedQualityHits >= expectedTagVectorCount &&
        indexedQualityDocuments >= campaigns.length
      ) {
        return {
          indexedTagVectorCount: indexedQualityHits,
          indexedDocumentVectorCount: indexedQualityDocuments,
        };
      }
      await new Promise<void>((resolve) => setTimeout(resolve, intervalMs));
    }

    throw new ServiceUnavailableException(
      `quality campaign ANN index가 준비되지 않았습니다: expected=${expectedTagVectorCount}`
    );
  }

  private async replaceServingCampaigns(
    current: CachedCampaign[],
    target: CachedCampaign[]
  ): Promise<void> {
    for (const campaign of current) {
      await this.campaignCacheRepository.deleteCampaignCacheById(campaign.id);
    }
    for (const campaign of target) {
      await this.campaignCacheRepository.saveCampaignCacheById(
        campaign.id,
        campaign
      );
    }
  }

  private async restoreAfterFailedLoad(
    previousCampaigns: CachedCampaign[]
  ): Promise<void> {
    try {
      const current = await this.campaignCacheRepository.getAllCampaigns({
        allowStale: false,
      });
      await this.replaceServingCampaigns(current, previousCampaigns);
    } catch {
      throw new ServiceUnavailableException(
        'quality campaign load와 serving cache rollback이 모두 실패했습니다.'
      );
    }
  }

  private normalizeText(value: string): string {
    return value.normalize('NFC').toLowerCase().replace(/\s+/g, ' ').trim();
  }

  private getPositiveInt(name: string, fallback: number): number {
    const raw = this.configService.get<string>(name);
    const parsed = raw ? Number.parseInt(raw, 10) : fallback;
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
  }
}
