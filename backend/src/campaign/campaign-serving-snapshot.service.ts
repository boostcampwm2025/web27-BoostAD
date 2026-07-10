import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { OnEvent } from '@nestjs/event-emitter';
import { CampaignCacheRepository } from './repository/campaign.cache.repository.interface';
import type { CachedCampaign } from './types/campaign.types';
import {
  resolveEmbeddingProfile,
  type EmbeddingProfile,
} from '../rtb/ml/embedding-profile';
import {
  CAMPAIGN_CACHE_REMOVED_EVENT,
  CAMPAIGN_CACHE_UPSERTED_EVENT,
  type CampaignCacheRemovedEvent,
  type CampaignCacheUpsertedEvent,
} from './events/campaign-cache.events';

export type ServingCampaign = Omit<
  CachedCampaign,
  'embeddingTags' | 'embeddingDocument'
> & {
  embeddingTags?: Record<string, Float32Array>;
  embeddingDocument?: Float32Array;
};

type SnapshotMutation = ServingCampaign | null;

type CampaignServingSnapshotState = {
  version: number;
  builtAtMs: number;
  campaignsById: ReadonlyMap<string, ServingCampaign>;
  campaignIdsByTag: ReadonlyMap<string, ReadonlySet<string>>;
};

@Injectable()
export class CampaignServingSnapshotService implements OnApplicationBootstrap {
  private readonly logger = new Logger(CampaignServingSnapshotService.name);
  private state: CampaignServingSnapshotState = {
    version: 0,
    builtAtMs: 0,
    campaignsById: new Map(),
    campaignIdsByTag: new Map(),
  };
  private initialized = false;
  private initializationInFlight: Promise<void> | null = null;
  private readonly mutationsDuringInitialization = new Map<
    string,
    SnapshotMutation
  >();
  private readonly enabled: boolean;
  private readonly embeddingProfile: EmbeddingProfile;
  private readonly requireDocumentEmbedding: boolean;

  constructor(
    private readonly campaignCacheRepository: CampaignCacheRepository,
    configService: ConfigService
  ) {
    this.embeddingProfile = resolveEmbeddingProfile(
      configService.get<string>('RTB_EMBEDDING_PROFILE')
    );
    this.requireDocumentEmbedding =
      configService.get<string>('RTB_DENSE_RETRIEVAL_MODE') ===
      'semantic_document';
    const campaignSource = configService.get<string>('RTB_CAMPAIGN_SOURCE');
    this.enabled = campaignSource
      ? campaignSource === 'local_snapshot'
      : configService.get<string>(
          'RTB_MATCHER_LOCAL_SNAPSHOT_ENABLED',
          'false'
        ) === 'true';
  }

  async onApplicationBootstrap(): Promise<void> {
    if (this.enabled) {
      await this.ensureInitialized();
    }
  }

  async findCampaignsByIds(ids: string[]): Promise<ServingCampaign[]> {
    const uniqueIds = [...new Set(ids.filter(Boolean))];
    if (uniqueIds.length === 0) {
      return [];
    }

    await this.ensureInitialized();

    const repairIds = uniqueIds.filter((id) => {
      const campaign = this.state.campaignsById.get(id);
      return !campaign || !this.hasRequiredEmbeddings(campaign);
    });

    if (repairIds.length > 0) {
      const repaired =
        await this.campaignCacheRepository.findCampaignCachesByIds(repairIds);
      this.upsertMany(
        repaired.map((campaign) => this.toServingCampaign(campaign))
      );
    }

    return uniqueIds.flatMap((id) => {
      const campaign = this.state.campaignsById.get(id);
      return campaign ? [campaign] : [];
    });
  }

  async findCampaignsByTags(tags: string[]): Promise<ServingCampaign[]> {
    await this.ensureInitialized();

    const campaignIds = new Set<string>();
    for (const tag of this.normalizeTags(tags)) {
      for (const campaignId of this.state.campaignIdsByTag.get(tag) ?? []) {
        campaignIds.add(campaignId);
      }
    }

    return [...campaignIds].flatMap((campaignId) => {
      const campaign = this.state.campaignsById.get(campaignId);
      return campaign ? [campaign] : [];
    });
  }

  getMetadata(): {
    version: number;
    builtAtMs: number;
    size: number;
    tagCount: number;
  } {
    return {
      version: this.state.version,
      builtAtMs: this.state.builtAtMs,
      size: this.state.campaignsById.size,
      tagCount: this.state.campaignIdsByTag.size,
    };
  }

  @OnEvent(CAMPAIGN_CACHE_UPSERTED_EVENT)
  onCampaignCacheUpserted(event: CampaignCacheUpsertedEvent): void {
    if (!this.enabled) {
      return;
    }
    const campaign = this.toServingCampaign(event.campaign);
    this.recordMutation(campaign.id, campaign);
    if (this.initialized) {
      this.upsertMany([campaign]);
    }
  }

  @OnEvent(CAMPAIGN_CACHE_REMOVED_EVENT)
  onCampaignCacheRemoved(event: CampaignCacheRemovedEvent): void {
    if (!this.enabled) {
      return;
    }
    this.recordMutation(event.campaignId, null);
    if (this.initialized) {
      this.remove(event.campaignId);
    }
  }

  private async ensureInitialized(): Promise<void> {
    if (this.initialized) {
      return;
    }

    if (!this.initializationInFlight) {
      this.initializationInFlight = this.buildInitialSnapshot().finally(() => {
        this.initializationInFlight = null;
      });
    }

    await this.initializationInFlight;
  }

  private async buildInitialSnapshot(): Promise<void> {
    const campaigns = await this.campaignCacheRepository.getAllCampaigns({
      allowStale: false,
    });
    const campaignsById = new Map(
      campaigns.map((campaign) => {
        const servingCampaign = this.toServingCampaign(campaign);
        return [servingCampaign.id, servingCampaign] as const;
      })
    );

    for (const [campaignId, mutation] of this.mutationsDuringInitialization) {
      if (mutation) {
        campaignsById.set(campaignId, mutation);
      } else {
        campaignsById.delete(campaignId);
      }
    }

    this.state = {
      version: this.state.version + 1,
      builtAtMs: Date.now(),
      campaignsById,
      campaignIdsByTag: this.buildTagIndex(campaignsById),
    };
    this.initialized = true;
    this.mutationsDuringInitialization.clear();
    this.logger.log(`RTB 캠페인 스냅샷 준비 완료: ${campaignsById.size}개`);
  }

  private recordMutation(campaignId: string, mutation: SnapshotMutation): void {
    if (!this.initialized) {
      this.mutationsDuringInitialization.set(campaignId, mutation);
    }
  }

  private upsertMany(campaigns: ServingCampaign[]): void {
    if (campaigns.length === 0) {
      return;
    }

    const campaignsById = new Map(this.state.campaignsById);
    for (const campaign of campaigns) {
      campaignsById.set(campaign.id, campaign);
    }
    this.state = {
      version: this.state.version + 1,
      builtAtMs: Date.now(),
      campaignsById,
      campaignIdsByTag: this.buildTagIndex(campaignsById),
    };
  }

  private remove(campaignId: string): void {
    if (!this.state.campaignsById.has(campaignId)) {
      return;
    }

    const campaignsById = new Map(this.state.campaignsById);
    campaignsById.delete(campaignId);
    this.state = {
      version: this.state.version + 1,
      builtAtMs: Date.now(),
      campaignsById,
      campaignIdsByTag: this.buildTagIndex(campaignsById),
    };
  }

  private hasRequiredEmbeddings(campaign: ServingCampaign): boolean {
    const hasTags = Boolean(
      campaign.tags?.length &&
      campaign.tags.every(
        (tagName) =>
          campaign.embeddingTags?.[tagName]?.length ===
          this.embeddingProfile.dimension
      )
    );
    const compatible =
      campaign.embeddingModelVersion === this.embeddingProfile.modelVersion ||
      (this.embeddingProfile.name === 'legacy_minilm' &&
        !campaign.embeddingModelVersion);
    const hasDocument =
      campaign.embeddingDocument?.length === this.embeddingProfile.dimension;
    return Boolean(
      compatible && hasTags && (!this.requireDocumentEmbedding || hasDocument)
    );
  }

  private toServingCampaign(campaign: CachedCampaign): ServingCampaign {
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
      ...campaign,
      embeddingTags,
      embeddingDocument,
    };
  }

  private buildTagIndex(
    campaignsById: ReadonlyMap<string, ServingCampaign>
  ): ReadonlyMap<string, ReadonlySet<string>> {
    const index = new Map<string, Set<string>>();
    for (const campaign of campaignsById.values()) {
      for (const tag of this.normalizeTags(campaign.tags ?? [])) {
        const campaignIds = index.get(tag) ?? new Set<string>();
        campaignIds.add(campaign.id);
        index.set(tag, campaignIds);
      }
    }
    return index;
  }

  private normalizeTags(tags: string[]): string[] {
    return [
      ...new Set(
        tags
          .map((tag) =>
            tag.normalize('NFC').toLowerCase().replace(/\s+/g, ' ').trim()
          )
          .filter(Boolean)
      ),
    ];
  }
}
