import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Job } from 'bullmq';
import { Logger, OnApplicationBootstrap } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { MLEngine } from 'src/rtb/ml/mlEngine.interface';
import { CampaignCacheRepository } from 'src/campaign/repository/campaign.cache.repository.interface';
import { ContextEmbeddingService } from 'src/rtb/context/context-embedding.service';
import type { ContextEmbeddingJobData } from 'src/queue/types/queue.type';
import { MetricsService } from 'src/metrics/metrics.service';

@Processor('embedding-queue', { autorun: false })
export class EmbeddingWorker
  extends WorkerHost
  implements OnApplicationBootstrap
{
  private readonly logger = new Logger(EmbeddingWorker.name);
  private startRequested = false;

  constructor(
    private readonly mlEngine: MLEngine,
    private readonly campaignCacheRepository: CampaignCacheRepository,
    private readonly contextEmbeddingService: ContextEmbeddingService,
    private readonly metricsService: MetricsService
  ) {
    super();
  }

  onApplicationBootstrap(): void {
    if (this.mlEngine.isReady()) {
      this.startWorker();
    }
  }

  @OnEvent('ml.model.ready')
  onModelReady(): void {
    this.startWorker();
  }

  private startWorker(): void {
    if (this.startRequested || this.worker.isRunning()) {
      return;
    }

    this.startRequested = true;
    void this.worker.run().catch((error) => {
      this.startRequested = false;
      this.logger.error('Embedding worker 실행 실패:', error);
    });
  }

  async process(job: Job): Promise<void> {
    this.logger.debug(`Processing job ${job.id} of type ${job.name}`);

    try {
      if (job.name === 'generate-campaign-embedding') {
        const { campaignId } = job.data as {
          campaignId: string;
        };
        await this.generateCampaignEmbedding(campaignId);
      } else if (job.name === 'generate-context-embedding') {
        await this.generateContextEmbedding(
          job as Job<ContextEmbeddingJobData>
        );
      } else {
        this.logger.warn(`Unknown job type: ${job.name}`);
      }
    } catch (error) {
      this.logger.error(`Job ${job.id} failed:`, error);
      throw error;
    }
  }

  private async generateContextEmbedding(job: Job<ContextEmbeddingJobData>) {
    const startedAt = process.hrtime.bigint();
    try {
      const embedding = await this.mlEngine.getEmbedding(job.data.text);
      await this.contextEmbeddingService.completeJob(job.data, embedding);
      this.metricsService.recordRtbContextJob('completed');
    } catch (error) {
      const configuredAttempts = job.opts.attempts ?? 1;
      const isFinalAttempt = job.attemptsMade + 1 >= configuredAttempts;
      if (isFinalAttempt) {
        await this.contextEmbeddingService.failJob(job.data, error);
      }
      this.metricsService.recordRtbContextJob('failed');
      throw error;
    } finally {
      this.metricsService.observeRtbContextEmbeddingDuration(
        Number(process.hrtime.bigint() - startedAt) / 1_000_000_000
      );
    }
  }

  private async generateCampaignEmbedding(campaignId: string) {
    // 1. Redis에서 캠페인 정보 조회 (태그 정보 필요)
    const campaign =
      await this.campaignCacheRepository.findCampaignCacheById(campaignId);

    if (!campaign) {
      this.logger.warn(`Campaign ${campaignId}를 찾을 수 없습니다.`);
      return;
    }

    if (!campaign.tags || campaign.tags.length === 0) {
      this.logger.warn(`Campaign ${campaignId}에 태그가 없습니다.`);
      return;
    }

    // 2. 각 태그별로 임베딩 생성
    const embeddingTags: { [tagName: string]: number[] } = {};

    for (const tagName of campaign.tags) {
      const embedding = await this.mlEngine.getEmbedding(tagName);
      embeddingTags[tagName] = embedding;
    }

    // 3. Redis에 태그별 임베딩 저장
    await this.campaignCacheRepository.updateCampaignEmbeddingTags(
      campaignId,
      embeddingTags
    );

    this.logger.log(
      `✅ ID:${campaignId.slice(0, 8)}... title:${campaign.title.slice(0, 15)}... 임베딩 생성 완료 (${campaign.tags.length}개 태그)`
    );
  }
}
