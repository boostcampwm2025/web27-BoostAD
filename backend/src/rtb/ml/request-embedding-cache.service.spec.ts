import { ConfigService } from '@nestjs/config';
import { MetricsService } from '../../metrics/metrics.service';
import { MLEngine } from './mlEngine.interface';
import { RequestEmbeddingCacheService } from './request-embedding-cache.service';

describe('RequestEmbeddingCacheService', () => {
  const embeddingA = [0.1, 0.2, 0.3];
  const embeddingB = [0.4, 0.5, 0.6];

  type MetricsMock = {
    incRtbEmbeddingL1Hit: jest.Mock;
    incRtbEmbeddingL1Miss: jest.Mock;
    incRtbEmbeddingL1Eviction: jest.Mock;
    incRtbEmbeddingL2Hit: jest.Mock;
    incRtbEmbeddingL2Miss: jest.Mock;
    incRtbEmbeddingL2Timeout: jest.Mock;
    incRtbEmbeddingL2WriteTimeout: jest.Mock;
    incRtbEmbeddingL2Error: jest.Mock;
    incRtbEmbeddingSingleflightWait: jest.Mock;
    observeRtbEmbeddingSingleflightDuration: jest.Mock;
    incRtbEmbeddingRuntime: jest.Mock;
    incRtbEmbeddingSource: jest.Mock;
  };

  type RedisMock = {
    get: jest.Mock;
    set: jest.Mock;
  };

  const buildMetrics = (): MetricsMock => ({
    incRtbEmbeddingL1Hit: jest.fn(),
    incRtbEmbeddingL1Miss: jest.fn(),
    incRtbEmbeddingL1Eviction: jest.fn(),
    incRtbEmbeddingL2Hit: jest.fn(),
    incRtbEmbeddingL2Miss: jest.fn(),
    incRtbEmbeddingL2Timeout: jest.fn(),
    incRtbEmbeddingL2WriteTimeout: jest.fn(),
    incRtbEmbeddingL2Error: jest.fn(),
    incRtbEmbeddingSingleflightWait: jest.fn(),
    observeRtbEmbeddingSingleflightDuration: jest.fn(),
    incRtbEmbeddingRuntime: jest.fn(),
    incRtbEmbeddingSource: jest.fn(),
  });

  const buildConfig = (overrides: Record<string, string> = {}) =>
    ({
      get: jest.fn((key: string, defaultValue?: string) => {
        if (key in overrides) {
          return overrides[key];
        }
        return defaultValue;
      }),
    }) as unknown as ConfigService;

  const buildMlEngine = (modelVersion = 'Xenova/all-MiniLM-L6-v2') => {
    let resolveEmbedding: ((value: number[]) => void) | null = null;
    let rejectEmbedding: ((reason?: unknown) => void) | null = null;
    const getEmbedding = jest.fn(
      () =>
        new Promise<number[]>((resolve, reject) => {
          resolveEmbedding = resolve;
          rejectEmbedding = reject;
        })
    );

    return {
      engine: {
        isReady: jest.fn(() => true),
        getModelVersion: jest.fn(() => modelVersion),
        getEmbeddingDimension: jest.fn(() => embeddingA.length),
        getEmbedding,
        calculateSimilarity: jest.fn(),
        computeTextSimilarity: jest.fn(),
      } as unknown as MLEngine,
      getEmbedding,
      resolveEmbedding: (value: number[]) => {
        if (!resolveEmbedding) {
          throw new Error('getEmbedding was not called');
        }
        resolveEmbedding(value);
      },
      rejectEmbedding: (reason: unknown) => {
        if (!rejectEmbedding) {
          throw new Error('getEmbedding was not called');
        }
        rejectEmbedding(reason);
      },
    };
  };

  const buildRedis = (): RedisMock => ({
    get: jest.fn().mockResolvedValue(null),
    set: jest.fn().mockResolvedValue('OK'),
  });

  const buildService = (options?: {
    overrides?: Record<string, string>;
    modelVersion?: string;
    metrics?: MetricsMock;
    redis?: RedisMock;
    ml?: ReturnType<typeof buildMlEngine>;
  }) => {
    const metrics = options?.metrics ?? buildMetrics();
    const redis = options?.redis ?? buildRedis();
    const ml = options?.ml ?? buildMlEngine(options?.modelVersion);
    const service = new RequestEmbeddingCacheService(
      ml.engine,
      metrics as unknown as MetricsService,
      buildConfig({
        RTB_EMBEDDING_L1_MAX_SIZE: '3',
        RTB_EMBEDDING_L2_LOOKUP_BUDGET_MS: '5',
        RTB_EMBEDDING_L2_WRITE_BUDGET_MS: '5',
        RTB_EMBEDDING_L2_ENABLED: 'true',
        ...(options?.overrides ?? {}),
      }),
      redis as never
    );
    return { service, metrics, redis, ml };
  };

  const flushMicrotasks = async () => {
    await Promise.resolve();
    await Promise.resolve();
  };

  it('U1: concurrent same tags share one runtime and one L2 SET', async () => {
    const { service, metrics, redis, ml } = buildService();
    const pending = Promise.all([
      service.resolve('TypeScript React'),
      service.resolve('typescript react'),
      service.resolve('TypeScript  React'),
    ]);

    await flushMicrotasks();
    expect(ml.getEmbedding).toHaveBeenCalledTimes(1);
    ml.resolveEmbedding(embeddingA);

    const results = await pending;
    expect(results.map((item) => item.embedding)).toEqual([
      embeddingA,
      embeddingA,
      embeddingA,
    ]);
    expect(redis.set).toHaveBeenCalledTimes(1);
    expect(metrics.incRtbEmbeddingRuntime).toHaveBeenCalledTimes(1);
    expect(metrics.incRtbEmbeddingSingleflightWait).toHaveBeenCalledTimes(2);
    expect(metrics.incRtbEmbeddingSource).toHaveBeenCalledTimes(3);
    expect(metrics.incRtbEmbeddingSource).toHaveBeenCalledWith('runtime');
    expect(service.getInFlightSize()).toBe(0);
  });

  it('U2: in-flight reject propagates, clears map, and allows retry', async () => {
    const { service, metrics, ml } = buildService();
    const first = service.resolve('alpha beta');
    const waiter = service.resolve('alpha beta');

    await flushMicrotasks();
    ml.rejectEmbedding(new Error('runtime failed'));

    await expect(first).rejects.toThrow('runtime failed');
    await expect(waiter).rejects.toThrow('runtime failed');
    expect(service.getInFlightSize()).toBe(0);
    expect(metrics.incRtbEmbeddingSingleflightWait).toHaveBeenCalledTimes(1);

    const retry = service.resolve('alpha beta');
    await flushMicrotasks();
    expect(ml.getEmbedding).toHaveBeenCalledTimes(2);
    ml.resolveEmbedding(embeddingA);
    await expect(retry).resolves.toMatchObject({
      embedding: embeddingA,
      source: 'runtime',
    });
  });

  it('U3: L2 timeout unblocks via fail-open runtime and increments timeout metric', async () => {
    jest.useFakeTimers();
    const redis = buildRedis();
    redis.get.mockImplementation(
      () =>
        new Promise(() => {
          /* never resolves */
        })
    );
    const ml = buildMlEngine();
    ml.getEmbedding.mockResolvedValue(embeddingA);
    const { service, metrics } = buildService({ redis, ml });

    const pending = service.resolve('timeout tags');
    await flushMicrotasks();
    await jest.advanceTimersByTimeAsync(5);
    await flushMicrotasks();

    const result = await pending;
    expect(result.source).toBe('runtime');
    expect(metrics.incRtbEmbeddingL2Timeout).toHaveBeenCalledTimes(1);
    expect(metrics.incRtbEmbeddingRuntime).toHaveBeenCalledTimes(1);
    expect(service.getInFlightSize()).toBe(0);
    jest.useRealTimers();
  });

  it('U4: different tag sets use independent flights without mutual await', async () => {
    const { service, ml } = buildService();
    let firstStarted = false;
    let secondStarted = false;
    let firstResolve: ((value: number[]) => void) | null = null;
    let secondResolve: ((value: number[]) => void) | null = null;

    ml.getEmbedding.mockImplementation(async (text: string) => {
      if (text.includes('one')) {
        firstStarted = true;
        return new Promise<number[]>((resolve) => {
          firstResolve = resolve;
        });
      }
      secondStarted = true;
      return new Promise<number[]>((resolve) => {
        secondResolve = resolve;
      });
    });

    const first = service.resolve('tag set one');
    const second = service.resolve('tag set two');
    await flushMicrotasks();

    expect(firstStarted).toBe(true);
    expect(secondStarted).toBe(true);
    expect(ml.getEmbedding).toHaveBeenCalledTimes(2);

    firstResolve?.(embeddingA);
    secondResolve?.(embeddingB);
    await expect(Promise.all([first, second])).resolves.toEqual([
      expect.objectContaining({ embedding: embeddingA }),
      expect.objectContaining({ embedding: embeddingB }),
    ]);
  });

  it('U5: L1 hit skips runtime on repeat resolve', async () => {
    const ml = buildMlEngine();
    ml.getEmbedding.mockResolvedValue(embeddingA);
    const { service, metrics } = buildService({ ml });

    await service.resolve('hot tags');
    const second = await service.resolve('hot tags');

    expect(second.source).toBe('tag-L1');
    expect(ml.getEmbedding).toHaveBeenCalledTimes(1);
    expect(metrics.incRtbEmbeddingL1Hit).toHaveBeenCalledTimes(1);
    expect(metrics.incRtbEmbeddingRuntime).toHaveBeenCalledTimes(1);
  });

  it('U6: L1 eviction removes oldest and later misses', async () => {
    const ml = buildMlEngine();
    ml.getEmbedding.mockImplementation(async (text: string) => {
      if (text.endsWith('a')) return [1, 0, 0];
      if (text.endsWith('b')) return [0, 1, 0];
      if (text.endsWith('c')) return [0, 0, 1];
      return [1, 1, 1];
    });
    const { service, metrics, redis } = buildService({
      ml,
      overrides: { RTB_EMBEDDING_L1_MAX_SIZE: '2' },
    });

    await service.resolve('tag a');
    await service.resolve('tag b');
    await service.resolve('tag c');

    expect(metrics.incRtbEmbeddingL1Eviction).toHaveBeenCalledTimes(1);
    expect(service.getL1Size()).toBe(2);

    redis.get.mockResolvedValue(null);
    ml.getEmbedding.mockClear();
    ml.getEmbedding.mockResolvedValue([1, 0, 0]);
    await service.resolve('tag a');
    expect(ml.getEmbedding).toHaveBeenCalledTimes(1);
  });

  it('U7: L2 hit promotes into L1 without runtime', async () => {
    const redis = buildRedis();
    redis.get.mockResolvedValue(JSON.stringify(embeddingA));
    const ml = buildMlEngine();
    const { service, metrics } = buildService({ redis, ml });

    const result = await service.resolve('from l2');
    expect(result.source).toBe('tag-L2');
    expect(ml.getEmbedding).not.toHaveBeenCalled();
    expect(metrics.incRtbEmbeddingL2Hit).toHaveBeenCalledTimes(1);
    expect(service.hasL1(result.cacheKey)).toBe(true);

    const second = await service.resolve('from l2');
    expect(second.source).toBe('tag-L1');
  });

  it('U8: modelVersion change misses previous L2 key', async () => {
    const redis = buildRedis();
    const store = new Map<string, string>();
    redis.get.mockImplementation(async (key: string) => store.get(key) ?? null);
    redis.set.mockImplementation(async (key: string, value: string) => {
      store.set(key, value);
      return 'OK';
    });

    const v1 = buildMlEngine('model-v1');
    v1.getEmbedding.mockResolvedValue(embeddingA);
    const first = buildService({ ml: v1, redis });
    const written = await first.service.resolve('versioned tags');
    expect(written.cacheKey).toContain('model-v1');
    expect(store.has(written.cacheKey)).toBe(true);

    const v2 = buildMlEngine('model-v2');
    v2.getEmbedding.mockResolvedValue(embeddingB);
    const second = buildService({ ml: v2, redis });
    const missed = await second.service.resolve('versioned tags');
    expect(missed.cacheKey).toContain('model-v2');
    expect(missed.source).toBe('runtime');
    expect(v2.getEmbedding).toHaveBeenCalledTimes(1);
  });

  it('U9: L2 lookup over budget takes timeout path and still returns embedding', async () => {
    jest.useFakeTimers();
    const redis = buildRedis();
    redis.get.mockImplementation(
      () =>
        new Promise((resolve) => {
          setTimeout(() => resolve(JSON.stringify(embeddingA)), 20);
        })
    );
    const ml = buildMlEngine();
    ml.getEmbedding.mockResolvedValue(embeddingB);
    const { service, metrics } = buildService({
      redis,
      ml,
      overrides: { RTB_EMBEDDING_L2_LOOKUP_BUDGET_MS: '5' },
    });

    const pending = service.resolve('slow l2');
    await flushMicrotasks();
    await jest.advanceTimersByTimeAsync(5);
    await flushMicrotasks();
    const result = await pending;

    expect(result.embedding).toEqual(embeddingB);
    expect(result.source).toBe('runtime');
    expect(metrics.incRtbEmbeddingL2Timeout).toHaveBeenCalledTimes(1);
    expect(metrics.incRtbEmbeddingRuntime).toHaveBeenCalledTimes(1);
    jest.useRealTimers();
  });

  it('U10: Redis throw fail-opens to runtime without throwing', async () => {
    const redis = buildRedis();
    redis.get.mockRejectedValue(new Error('redis down'));
    const ml = buildMlEngine();
    ml.getEmbedding.mockResolvedValue(embeddingA);
    const { service, metrics } = buildService({ redis, ml });

    await expect(service.resolve('redis fail')).resolves.toMatchObject({
      embedding: embeddingA,
      source: 'runtime',
    });
    expect(metrics.incRtbEmbeddingL2Error).toHaveBeenCalledTimes(1);
    expect(metrics.incRtbEmbeddingRuntime).toHaveBeenCalledTimes(1);
  });

  it('U11: L2 write over budget does not hold the RTB result', async () => {
    jest.useFakeTimers();
    const redis = buildRedis();
    redis.set.mockImplementation(
      () =>
        new Promise(() => {
          /* never resolves */
        })
    );
    const ml = buildMlEngine();
    ml.getEmbedding.mockResolvedValue(embeddingA);
    const { service, metrics } = buildService({ redis, ml });

    const pending = service.resolve('slow l2 write');
    await flushMicrotasks();
    await jest.advanceTimersByTimeAsync(5);
    await flushMicrotasks();

    await expect(pending).resolves.toMatchObject({
      embedding: embeddingA,
      source: 'runtime',
    });
    expect(metrics.incRtbEmbeddingL2WriteTimeout).toHaveBeenCalledTimes(1);
    expect(service.getInFlightSize()).toBe(0);
    jest.useRealTimers();
  });

  it('U12: invalid L2 payload is rejected and replaced by runtime output', async () => {
    const redis = buildRedis();
    redis.get.mockResolvedValue(JSON.stringify([0.1, 0.2]));
    const ml = buildMlEngine();
    ml.getEmbedding.mockResolvedValue(embeddingA);
    const { service, metrics } = buildService({ redis, ml });

    await expect(service.resolve('invalid l2')).resolves.toMatchObject({
      embedding: embeddingA,
      source: 'runtime',
    });
    expect(metrics.incRtbEmbeddingL2Error).toHaveBeenCalledTimes(1);
    expect(redis.set).toHaveBeenCalledTimes(1);
  });
});
