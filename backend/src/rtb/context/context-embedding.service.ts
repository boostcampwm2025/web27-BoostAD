import { createHash } from 'crypto';
import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { ConfigService } from '@nestjs/config';
import { Queue } from 'bullmq';
import { IOREDIS_CLIENT } from '../../redis/redis.constant';
import type { AppIORedisClient } from '../../redis/redis.type';
import { MetricsService } from '../../metrics/metrics.service';
import { MLEngine } from '../ml/mlEngine.interface';
import type { ContextEmbeddingJobData } from '../../queue/types/queue.type';

export type ContextEmbeddingStatus = 'READY' | 'PENDING' | 'FAILED';

export type ContextEmbeddingState = {
  status: ContextEmbeddingStatus;
  contextId: string;
  contentHash: string;
  modelVersion: string;
  embedding?: number[];
  updatedAt: string;
  failureReason?: string;
};

export type ContextObserveInput = {
  title?: string;
  body?: string;
  tags: string[];
};

export type ContextDecisionResult =
  | { status: 'READY'; embedding: number[]; source: 'L1' | 'L2' }
  | { status: 'PENDING' | 'FAILED' | 'MISS' | 'TIMEOUT' | 'ERROR' };

class ContextLookupTimeoutError extends Error {}

type ReadyL1Entry = {
  embedding: number[];
  expiresAtMs: number;
};

@Injectable()
export class ContextEmbeddingService {
  private readonly maxBodyChars: number;
  private readonly readyTtlSeconds: number;
  private readonly pendingTtlSeconds: number;
  private readonly jobLockTtlSeconds: number;
  private readonly lookupBudgetMs: number;
  private readonly readyL1MaxSize: number;
  private readonly readyL1TtlMs: number;
  private readonly readyL1 = new Map<string, ReadyL1Entry>();

  constructor(
    private readonly mlEngine: MLEngine,
    private readonly metricsService: MetricsService,
    private readonly configService: ConfigService,
    @Inject(IOREDIS_CLIENT) private readonly redis: AppIORedisClient,
    @InjectQueue('embedding-queue')
    private readonly embeddingQueue: Queue<ContextEmbeddingJobData>
  ) {
    this.maxBodyChars = this.getPositiveInt(
      'RTB_CONTEXT_MAX_BODY_CHARS',
      8_000
    );
    this.readyTtlSeconds = this.getPositiveInt(
      'RTB_CONTEXT_READY_TTL_SECONDS',
      7 * 24 * 60 * 60
    );
    this.pendingTtlSeconds = this.getPositiveInt(
      'RTB_CONTEXT_PENDING_TTL_SECONDS',
      10 * 60
    );
    this.jobLockTtlSeconds = this.getPositiveInt(
      'RTB_CONTEXT_JOB_LOCK_TTL_SECONDS',
      10 * 60
    );
    this.lookupBudgetMs = this.getPositiveInt(
      'RTB_CONTEXT_LOOKUP_BUDGET_MS',
      5
    );
    this.readyL1MaxSize = this.getPositiveInt('RTB_CONTEXT_L1_MAX_SIZE', 1_000);
    this.readyL1TtlMs = this.getPositiveInt(
      'RTB_CONTEXT_L1_TTL_MS',
      5 * 60 * 1_000
    );
  }

  async observe(input: ContextObserveInput): Promise<ContextEmbeddingState> {
    const canonical = this.canonicalize(input);
    if (!canonical.embeddingText) {
      throw new BadRequestException('title, body, tags 중 하나는 필요합니다.');
    }
    const modelVersion = this.mlEngine.getModelVersion();
    const contentHash = createHash('sha256')
      .update(canonical.serialized)
      .digest('hex');
    const contextId = this.buildContextId(contentHash);
    const stateKey = this.buildStateKey(modelVersion, contentHash);
    const existing = await this.readState(stateKey);
    if (existing?.status === 'READY') {
      if (this.isValidEmbedding(existing.embedding)) {
        this.setReadyL1(stateKey, existing.embedding);
      }
      this.metricsService.recordRtbContextObserve(existing.status);
      return existing;
    }
    if (existing?.status === 'PENDING') {
      this.metricsService.recordRtbContextObserve(existing.status);
      this.metricsService.recordRtbContextJob('deduplicated');
      return existing;
    }

    const lockKey = this.buildJobLockKey(modelVersion, contentHash);
    const claimed = await this.redis.set(
      lockKey,
      '1',
      'EX',
      this.jobLockTtlSeconds,
      'NX'
    );
    if (claimed !== 'OK') {
      const raced = await this.readState(stateKey);
      const pending =
        raced ??
        this.buildState('PENDING', contextId, contentHash, modelVersion);
      this.metricsService.recordRtbContextObserve(pending.status);
      this.metricsService.recordRtbContextJob('deduplicated');
      return pending;
    }

    const pending = this.buildState(
      'PENDING',
      contextId,
      contentHash,
      modelVersion
    );
    await this.writeState(stateKey, pending, this.pendingTtlSeconds);

    const job: ContextEmbeddingJobData = {
      contextId,
      contentHash,
      modelVersion,
      text: canonical.embeddingText,
    };
    try {
      await this.embeddingQueue.add('generate-context-embedding', job, {
        jobId: this.buildJobId(modelVersion, contentHash),
        removeOnComplete: true,
        removeOnFail: 1_000,
        attempts: 3,
        backoff: { type: 'exponential', delay: 1_000 },
      });
      this.metricsService.recordRtbContextJob('enqueued');
      this.metricsService.recordRtbContextObserve('PENDING');
      return pending;
    } catch (error) {
      const failed = this.buildState(
        'FAILED',
        contextId,
        contentHash,
        modelVersion,
        undefined,
        error instanceof Error ? error.message : String(error)
      );
      await Promise.all([
        this.writeState(stateKey, failed, this.pendingTtlSeconds),
        this.redis.del(lockKey),
      ]);
      this.metricsService.recordRtbContextJob('failed');
      this.metricsService.recordRtbContextObserve('FAILED');
      return failed;
    }
  }

  async getState(contextId: string): Promise<ContextEmbeddingState | null> {
    const contentHash = this.parseContextId(contextId);
    if (!contentHash) {
      return null;
    }
    return this.readState(
      this.buildStateKey(this.mlEngine.getModelVersion(), contentHash)
    );
  }

  async resolveForDecision(contextId: string): Promise<ContextDecisionResult> {
    const contentHash = this.parseContextId(contextId);
    if (!contentHash) {
      return { status: 'MISS' };
    }

    const stateKey = this.buildStateKey(
      this.mlEngine.getModelVersion(),
      contentHash
    );
    const l1 = this.getReadyFromL1(stateKey);
    if (l1) {
      this.metricsService.recordRtbContextCache('l1_hit');
      return { status: 'READY', embedding: l1, source: 'L1' };
    }
    this.metricsService.recordRtbContextCache('l1_miss');

    try {
      const state = await this.withLookupTimeout(this.readState(stateKey));
      if (!state) {
        return { status: 'MISS' };
      }
      if (state.status !== 'READY') {
        return { status: state.status };
      }
      if (!this.isValidEmbedding(state.embedding)) {
        return { status: 'ERROR' };
      }
      this.setReadyL1(stateKey, state.embedding);
      this.metricsService.recordRtbContextCache('l2_hit');
      return { status: 'READY', embedding: state.embedding, source: 'L2' };
    } catch (error) {
      return {
        status:
          error instanceof ContextLookupTimeoutError ? 'TIMEOUT' : 'ERROR',
      };
    }
  }

  clearReadyL1(): void {
    this.readyL1.clear();
  }

  getReadyL1Size(): number {
    return this.readyL1.size;
  }

  async completeJob(
    job: ContextEmbeddingJobData,
    embedding: number[]
  ): Promise<void> {
    if (
      job.modelVersion !== this.mlEngine.getModelVersion() ||
      embedding.length !== this.mlEngine.getEmbeddingDimension() ||
      embedding.some((value) => !Number.isFinite(value))
    ) {
      throw new Error('Context embedding contract mismatch');
    }

    const state = this.buildState(
      'READY',
      job.contextId,
      job.contentHash,
      job.modelVersion,
      embedding
    );
    await Promise.all([
      this.writeState(
        this.buildStateKey(job.modelVersion, job.contentHash),
        state,
        this.readyTtlSeconds
      ),
      this.redis.del(this.buildJobLockKey(job.modelVersion, job.contentHash)),
    ]);
  }

  async failJob(job: ContextEmbeddingJobData, error: unknown): Promise<void> {
    const failed = this.buildState(
      'FAILED',
      job.contextId,
      job.contentHash,
      job.modelVersion,
      undefined,
      error instanceof Error ? error.message : String(error)
    );
    await Promise.all([
      this.writeState(
        this.buildStateKey(job.modelVersion, job.contentHash),
        failed,
        this.pendingTtlSeconds
      ),
      this.redis.del(this.buildJobLockKey(job.modelVersion, job.contentHash)),
    ]);
  }

  private canonicalize(input: ContextObserveInput): {
    serialized: string;
    embeddingText: string;
  } {
    const title = this.normalizeText(input.title ?? '');
    const body = this.normalizeText(input.body ?? '').slice(
      0,
      this.maxBodyChars
    );
    const tags = [
      ...new Set(
        input.tags.map((tag) => this.normalizeText(tag)).filter(Boolean)
      ),
    ].sort();
    const serialized = JSON.stringify({ title, body, tags });
    return {
      serialized,
      embeddingText: [title, body, tags.join(' ')].filter(Boolean).join('\n'),
    };
  }

  private normalizeText(value: string): string {
    return value.normalize('NFC').toLowerCase().replace(/\s+/g, ' ').trim();
  }

  private buildContextId(contentHash: string): string {
    return `ctx_${contentHash}`;
  }

  private parseContextId(contextId: string): string | null {
    const match = /^ctx_([a-f0-9]{64})$/.exec(contextId);
    return match?.[1] ?? null;
  }

  private buildStateKey(modelVersion: string, contentHash: string): string {
    return `context-embedding:${modelVersion}:${contentHash}`;
  }

  private buildJobLockKey(modelVersion: string, contentHash: string): string {
    return `embedding-job:${modelVersion}:${contentHash}`;
  }

  private buildJobId(modelVersion: string, contentHash: string): string {
    const versionHash = createHash('sha256')
      .update(modelVersion)
      .digest('hex')
      .slice(0, 16);
    return `context-${versionHash}-${contentHash}`;
  }

  private buildState(
    status: ContextEmbeddingStatus,
    contextId: string,
    contentHash: string,
    modelVersion: string,
    embedding?: number[],
    failureReason?: string
  ): ContextEmbeddingState {
    return {
      status,
      contextId,
      contentHash,
      modelVersion,
      ...(embedding ? { embedding } : {}),
      updatedAt: new Date().toISOString(),
      ...(failureReason ? { failureReason } : {}),
    };
  }

  private async readState(key: string): Promise<ContextEmbeddingState | null> {
    const raw = await this.redis.get(key);
    if (!raw) {
      return null;
    }
    try {
      const parsed = JSON.parse(raw) as ContextEmbeddingState;
      if (!['READY', 'PENDING', 'FAILED'].includes(parsed.status)) {
        return null;
      }
      return parsed;
    } catch {
      return null;
    }
  }

  private async writeState(
    key: string,
    state: ContextEmbeddingState,
    ttlSeconds: number
  ): Promise<void> {
    await this.redis.set(key, JSON.stringify(state), 'EX', ttlSeconds);
  }

  private getReadyFromL1(key: string): number[] | null {
    const entry = this.readyL1.get(key);
    if (!entry) {
      return null;
    }
    if (entry.expiresAtMs <= Date.now()) {
      this.readyL1.delete(key);
      return null;
    }
    this.readyL1.delete(key);
    this.readyL1.set(key, entry);
    return entry.embedding;
  }

  private setReadyL1(key: string, embedding: number[]): void {
    if (this.readyL1.has(key)) {
      this.readyL1.delete(key);
    }
    this.readyL1.set(key, {
      embedding,
      expiresAtMs: Date.now() + this.readyL1TtlMs,
    });
    while (this.readyL1.size > this.readyL1MaxSize) {
      const oldestKey = this.readyL1.keys().next().value as string | undefined;
      if (!oldestKey) {
        break;
      }
      this.readyL1.delete(oldestKey);
      this.metricsService.recordRtbContextCache('eviction');
    }
  }

  private isValidEmbedding(value: unknown): value is number[] {
    return (
      Array.isArray(value) &&
      value.length === this.mlEngine.getEmbeddingDimension() &&
      value.every((item) => typeof item === 'number' && Number.isFinite(item))
    );
  }

  private withLookupTimeout<T>(promise: Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new ContextLookupTimeoutError()),
        this.lookupBudgetMs
      );
      promise.then(
        (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        (error) => {
          clearTimeout(timer);
          reject(error);
        }
      );
    });
  }

  private getPositiveInt(key: string, fallback: number): number {
    const raw = this.configService.get<string>(key);
    const parsed = raw == null ? Number.NaN : Number(raw);
    return Number.isFinite(parsed) && parsed > 0
      ? Math.floor(parsed)
      : fallback;
  }
}
