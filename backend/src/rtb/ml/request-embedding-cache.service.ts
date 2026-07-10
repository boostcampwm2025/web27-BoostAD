import { createHash } from 'crypto';
import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { IOREDIS_CLIENT } from 'src/redis/redis.constant';
import type { AppIORedisClient } from 'src/redis/redis.type';
import { MetricsService } from '../../metrics/metrics.service';
import { MLEngine } from '../ml/mlEngine.interface';

export type EmbeddingSource = 'tag-L1' | 'tag-L2' | 'runtime';

export type EmbeddingResolveResult = {
  embedding: number[];
  source: EmbeddingSource;
  cacheKey: string;
};

export type EmbeddingPendingReason = 'miss' | 'timeout' | 'error' | 'in-flight';

export type EmbeddingCacheProbeResult =
  | (EmbeddingResolveResult & { status: 'ready' })
  | {
      status: 'pending';
      reason: EmbeddingPendingReason;
      cacheKey: string;
    };

type FlightResult = {
  embedding: number[];
  source: EmbeddingSource;
};

class L2OperationTimeoutError extends Error {
  constructor(readonly operation: 'lookup' | 'write') {
    super(`L2_${operation.toUpperCase()}_TIMEOUT`);
  }
}

@Injectable()
export class RequestEmbeddingCacheService {
  private readonly l1 = new Map<string, number[]>();
  private readonly inFlight = new Map<string, Promise<FlightResult>>();
  private readonly l1MaxSize: number;
  private readonly l2LookupBudgetMs: number;
  private readonly l2WriteBudgetMs: number;
  private readonly l2TtlSeconds: number;
  private readonly l2Enabled: boolean;
  private readonly backgroundMaxConcurrency: number;
  private readonly backgroundMaxQueueSize: number;
  private backgroundActive = 0;
  private readonly backgroundQueue: Array<() => void> = [];

  constructor(
    private readonly mlEngine: MLEngine,
    private readonly metricsService: MetricsService,
    private readonly configService: ConfigService,
    @Inject(IOREDIS_CLIENT) private readonly redis: AppIORedisClient
  ) {
    this.l1MaxSize = this.getPositiveInt('RTB_EMBEDDING_L1_MAX_SIZE', 1_000);
    this.l2LookupBudgetMs = this.getPositiveInt(
      'RTB_EMBEDDING_L2_LOOKUP_BUDGET_MS',
      5
    );
    this.l2WriteBudgetMs = this.getPositiveInt(
      'RTB_EMBEDDING_L2_WRITE_BUDGET_MS',
      5
    );
    this.l2TtlSeconds = this.getPositiveInt(
      'RTB_EMBEDDING_L2_TTL_SECONDS',
      7 * 24 * 60 * 60
    );
    this.l2Enabled =
      this.configService.get<string>('RTB_EMBEDDING_L2_ENABLED', 'true') ===
      'true';
    this.backgroundMaxConcurrency = this.getPositiveInt(
      'RTB_EMBEDDING_BACKGROUND_MAX_CONCURRENCY',
      1
    );
    this.backgroundMaxQueueSize = this.getPositiveInt(
      'RTB_EMBEDDING_BACKGROUND_MAX_QUEUE_SIZE',
      100
    );
  }

  buildCacheKey(text: string, modelVersion = this.mlEngine.getModelVersion()) {
    const canonical = this.normalizeText(text);
    const hash = createHash('sha256').update(canonical).digest('hex');
    return `tag-embedding:${modelVersion}:${hash}`;
  }

  clearL1() {
    this.l1.clear();
  }

  getL1Size() {
    return this.l1.size;
  }

  hasL1(cacheKey: string) {
    return this.l1.has(cacheKey);
  }

  getInFlightSize() {
    return this.inFlight.size;
  }

  getBackgroundState() {
    return {
      active: this.backgroundActive,
      queued: this.backgroundQueue.length,
    };
  }

  /**
   * [동기 경로] 벡터가 꼭 필요할 때 사용.
   * L1 → single-flight → L2(budget) → 없으면 runtime까지 await 해서 반드시 embedding을 반환.
   */
  async resolve(text: string): Promise<EmbeddingResolveResult> {
    const cacheKey = this.buildCacheKey(text);
    const l1Hit = this.getFromL1(cacheKey);
    if (l1Hit) {
      this.metricsService.incRtbEmbeddingL1Hit();
      this.metricsService.incRtbEmbeddingSource('tag-L1');
      return { embedding: l1Hit, source: 'tag-L1', cacheKey };
    }

    this.metricsService.incRtbEmbeddingL1Miss();

    // 같은 key가 이미 생성 중이면 Xenova를 또 돌리지 않고 그 Promise만 기다림
    const existing = this.inFlight.get(cacheKey);
    if (existing) {
      this.metricsService.incRtbEmbeddingSingleflightWait();
      const waitStarted = process.hrtime.bigint();
      try {
        const { embedding, source } = await existing;
        this.metricsService.incRtbEmbeddingSource(source);
        return { embedding, source, cacheKey };
      } finally {
        const waitedSeconds =
          Number(process.hrtime.bigint() - waitStarted) / 1_000_000_000;
        this.metricsService.observeRtbEmbeddingSingleflightDuration(
          waitedSeconds
        );
      }
    }

    const flight = this.loadOrGenerate(text, cacheKey);
    this.inFlight.set(cacheKey, flight);

    try {
      const { embedding, source } = await flight;
      this.metricsService.incRtbEmbeddingSource(source);
      return { embedding, source, cacheKey };
    } finally {
      this.inFlight.delete(cacheKey);
    }
  }

  /**
   * [비차단 경로 / Phase 3B] decision 스레드가 runtime을 기다리면 안 될 때 사용.
   * - L1/L2 hit → ready (바로 ANN 가능)
   * - miss/timeout/in-flight → pending만 반환 + background에서 생성 예약
   * Matcher는 pending이면 lexical fallback으로 즉시 응답한다.
   */
  async resolveCachedOrSchedule(
    text: string
  ): Promise<EmbeddingCacheProbeResult> {
    const cacheKey = this.buildCacheKey(text);
    const l1Hit = this.getFromL1(cacheKey);
    if (l1Hit) {
      this.metricsService.incRtbEmbeddingL1Hit();
      this.metricsService.incRtbEmbeddingSource('tag-L1');
      return {
        status: 'ready',
        embedding: l1Hit,
        source: 'tag-L1',
        cacheKey,
      };
    }

    this.metricsService.incRtbEmbeddingL1Miss();
    // 이미 누군가 생성 중 → 이번 요청은 기다리지 않고 pending
    if (this.inFlight.has(cacheKey)) {
      this.metricsService.recordRtbEmbeddingBackground('deduplicated');
      return { status: 'pending', reason: 'in-flight', cacheKey };
    }

    let pendingReason: EmbeddingPendingReason = 'miss';
    if (this.l2Enabled) {
      const l2 = await this.getFromL2WithBudget(cacheKey);
      if (l2.status === 'hit') {
        this.setL1(cacheKey, l2.embedding);
        this.metricsService.incRtbEmbeddingSource('tag-L2');
        return {
          status: 'ready',
          embedding: l2.embedding,
          source: 'tag-L2',
          cacheKey,
        };
      }
      pendingReason = l2.status;
    }

    // 후속 요청을 위해 뒤에서만 warm-up. 이번 decision은 pending으로 끝낸다.
    this.startBackgroundGeneration(text, cacheKey);
    return { status: 'pending', reason: pendingReason, cacheKey };
  }

  private async loadOrGenerate(
    text: string,
    cacheKey: string
  ): Promise<FlightResult> {
    if (this.l2Enabled) {
      const l2 = await this.getFromL2WithBudget(cacheKey);
      if (l2.status === 'hit') {
        this.setL1(cacheKey, l2.embedding);
        return { embedding: l2.embedding, source: 'tag-L2' };
      }
    }

    return this.generateAndStore(text, cacheKey);
  }

  private async generateAndStore(
    text: string,
    cacheKey: string
  ): Promise<FlightResult> {
    this.metricsService.incRtbEmbeddingRuntime();
    const embedding = await this.mlEngine.getEmbedding(text);
    if (!this.isValidEmbedding(embedding)) {
      throw new Error('Runtime embedding payload is invalid');
    }
    this.setL1(cacheKey, embedding);
    if (this.l2Enabled) {
      await this.setL2WithBudget(cacheKey, embedding);
    }
    return { embedding, source: 'runtime' };
  }

  /**
   * cold miss warm-up. API 프로세스를 다시 포화시키지 않도록
   * 동시성/큐 상한을 두고, 초과분은 dropped 처리한다(decision은 이미 lexical로 응답됨).
   */
  private startBackgroundGeneration(text: string, cacheKey: string): void {
    if (this.inFlight.has(cacheKey)) {
      this.metricsService.recordRtbEmbeddingBackground('deduplicated');
      return;
    }

    if (
      this.backgroundActive >= this.backgroundMaxConcurrency &&
      this.backgroundQueue.length >= this.backgroundMaxQueueSize
    ) {
      this.metricsService.recordRtbEmbeddingBackground('dropped');
      return;
    }

    this.metricsService.recordRtbEmbeddingBackground('scheduled');
    const flight = new Promise<FlightResult>((resolve, reject) => {
      const task = () => {
        this.backgroundActive += 1;
        void this.generateAndStore(text, cacheKey)
          .then(resolve, reject)
          .finally(() => {
            this.backgroundActive -= 1;
            this.drainBackgroundQueue();
          });
      };

      if (this.backgroundActive < this.backgroundMaxConcurrency) {
        task();
      } else {
        this.backgroundQueue.push(task);
      }
    });
    this.inFlight.set(cacheKey, flight);
    void flight
      .then(() => {
        this.metricsService.recordRtbEmbeddingBackground('completed');
      })
      .catch(() => {
        this.metricsService.recordRtbEmbeddingBackground('failed');
      })
      .finally(() => {
        if (this.inFlight.get(cacheKey) === flight) {
          this.inFlight.delete(cacheKey);
        }
      });
  }

  private drainBackgroundQueue(): void {
    while (
      this.backgroundActive < this.backgroundMaxConcurrency &&
      this.backgroundQueue.length > 0
    ) {
      this.backgroundQueue.shift()?.();
    }
  }

  private getFromL1(cacheKey: string): number[] | null {
    const cached = this.l1.get(cacheKey);
    if (!cached) {
      return null;
    }
    this.l1.delete(cacheKey);
    this.l1.set(cacheKey, cached);
    return cached;
  }

  private setL1(cacheKey: string, embedding: number[]) {
    if (this.l1.has(cacheKey)) {
      this.l1.delete(cacheKey);
    }
    this.l1.set(cacheKey, embedding);
    while (this.l1.size > this.l1MaxSize) {
      const oldestKey = this.l1.keys().next().value as string | undefined;
      if (!oldestKey) {
        break;
      }
      this.l1.delete(oldestKey);
      this.metricsService.incRtbEmbeddingL1Eviction();
    }
  }

  private async getFromL2WithBudget(
    cacheKey: string
  ): Promise<
    | { status: 'hit'; embedding: number[] }
    | { status: 'miss' }
    | { status: 'timeout' }
    | { status: 'error' }
  > {
    try {
      const value = await this.withTimeout(
        this.redis.get(cacheKey),
        this.l2LookupBudgetMs
      );
      if (value == null) {
        this.metricsService.incRtbEmbeddingL2Miss();
        return { status: 'miss' };
      }
      const parsed = JSON.parse(value) as unknown;
      if (!this.isValidEmbedding(parsed)) {
        this.metricsService.incRtbEmbeddingL2Error();
        return { status: 'error' };
      }
      this.metricsService.incRtbEmbeddingL2Hit();
      return { status: 'hit', embedding: parsed };
    } catch (error) {
      if (
        error instanceof L2OperationTimeoutError &&
        error.operation === 'lookup'
      ) {
        this.metricsService.incRtbEmbeddingL2Timeout();
        return { status: 'timeout' };
      }
      this.metricsService.incRtbEmbeddingL2Error();
      return { status: 'error' };
    }
  }

  private async setL2WithBudget(cacheKey: string, embedding: number[]) {
    try {
      await this.withTimeout(
        this.redis.set(
          cacheKey,
          JSON.stringify(embedding),
          'EX',
          this.l2TtlSeconds
        ),
        this.l2WriteBudgetMs,
        'write'
      );
    } catch (error) {
      if (
        error instanceof L2OperationTimeoutError &&
        error.operation === 'write'
      ) {
        this.metricsService.incRtbEmbeddingL2WriteTimeout();
        return;
      }
      this.metricsService.incRtbEmbeddingL2Error();
    }
  }

  private withTimeout<T>(
    promise: Promise<T>,
    budgetMs: number,
    operation: 'lookup' | 'write' = 'lookup'
  ): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new L2OperationTimeoutError(operation));
      }, budgetMs);
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

  private normalizeText(text: string): string {
    return text.normalize('NFC').toLowerCase().replace(/\s+/g, ' ').trim();
  }

  private isValidEmbedding(value: unknown): value is number[] {
    return (
      Array.isArray(value) &&
      value.length === this.mlEngine.getEmbeddingDimension() &&
      value.every((item) => typeof item === 'number' && Number.isFinite(item))
    );
  }

  private getPositiveInt(key: string, fallback: number): number {
    const raw = this.configService.get<string>(key);
    const parsed = raw == null ? Number.NaN : Number(raw);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      return fallback;
    }
    return Math.floor(parsed);
  }
}
