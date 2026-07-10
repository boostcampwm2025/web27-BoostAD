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

  async resolve(text: string): Promise<EmbeddingResolveResult> {
    const cacheKey = this.buildCacheKey(text);
    const l1Hit = this.getFromL1(cacheKey);
    if (l1Hit) {
      this.metricsService.incRtbEmbeddingL1Hit();
      this.metricsService.incRtbEmbeddingSource('tag-L1');
      return { embedding: l1Hit, source: 'tag-L1', cacheKey };
    }

    this.metricsService.incRtbEmbeddingL1Miss();

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

  private async loadOrGenerate(
    text: string,
    cacheKey: string
  ): Promise<FlightResult> {
    if (this.l2Enabled) {
      const l2 = await this.getFromL2WithBudget(cacheKey);
      if (l2.status === 'hit' && l2.embedding) {
        this.setL1(cacheKey, l2.embedding);
        return { embedding: l2.embedding, source: 'tag-L2' };
      }
    }

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
