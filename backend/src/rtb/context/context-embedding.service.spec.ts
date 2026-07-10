import { ConfigService } from '@nestjs/config';
import { MetricsService } from '../../metrics/metrics.service';
import { MLEngine } from '../ml/mlEngine.interface';
import { ContextEmbeddingService } from './context-embedding.service';
import type { ContextEmbeddingJobData } from '../../queue/types/queue.type';

describe('ContextEmbeddingService', () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  const buildRedis = () => {
    const store = new Map<string, string>();
    return {
      store,
      get: jest.fn(async (key: string) => store.get(key) ?? null),
      set: jest.fn(
        async (key: string, value: string, ...args: Array<string | number>) => {
          if (args.includes('NX') && store.has(key)) {
            return null;
          }
          store.set(key, value);
          return 'OK';
        }
      ),
      del: jest.fn(async (key: string) => (store.delete(key) ? 1 : 0)),
    };
  };

  const buildHarness = (options?: {
    redis?: ReturnType<typeof buildRedis>;
    modelVersion?: string;
    config?: Record<string, string>;
  }) => {
    const redis = options?.redis ?? buildRedis();
    const queue = { add: jest.fn().mockResolvedValue({ id: 'job' }) };
    const metrics = {
      recordRtbContextObserve: jest.fn(),
      recordRtbContextJob: jest.fn(),
      recordRtbContextCache: jest.fn(),
    };
    const mlEngine = {
      isReady: jest.fn(() => true),
      getModelVersion: jest.fn(() => options?.modelVersion ?? 'model-v1'),
      getEmbeddingDimension: jest.fn(() => 3),
      getEmbedding: jest.fn(),
      calculateSimilarity: jest.fn(),
      computeTextSimilarity: jest.fn(),
    } as unknown as MLEngine;
    const config = {
      get: jest.fn((key: string, defaultValue?: string) =>
        options?.config && key in options.config
          ? options.config[key]
          : defaultValue
      ),
    } as unknown as ConfigService;
    const service = new ContextEmbeddingService(
      mlEngine,
      metrics as unknown as MetricsService,
      config,
      redis as never,
      queue as never
    );
    return { service, redis, queue, metrics, mlEngine };
  };

  it('3C-U1: canonical content variants share one hash and one job', async () => {
    const { service, queue, metrics } = buildHarness();

    const first = await service.observe({
      title: ' React  Cache ',
      body: 'Hello\nWorld',
      tags: ['TypeScript', 'react'],
    });
    const second = await service.observe({
      title: 'react cache',
      body: 'hello world',
      tags: ['react', 'TYPESCRIPT', 'react'],
    });

    expect(first.status).toBe('PENDING');
    expect(second.contextId).toBe(first.contextId);
    expect(second.contentHash).toBe(first.contentHash);
    expect(queue.add).toHaveBeenCalledTimes(1);
    expect(metrics.recordRtbContextJob).toHaveBeenCalledWith('deduplicated');
  });

  it('3C-U2: completed worker output becomes READY and reusable', async () => {
    const { service, queue, redis, metrics } = buildHarness();
    const pending = await service.observe({
      title: 'title',
      body: 'body',
      tags: ['tag'],
    });
    const job = queue.add.mock.calls[0][1] as ContextEmbeddingJobData;

    await service.completeJob(job, [0.1, 0.2, 0.3]);

    await expect(service.getState(pending.contextId)).resolves.toMatchObject({
      status: 'READY',
      contextId: pending.contextId,
      embedding: [0.1, 0.2, 0.3],
    });
    await expect(
      service.resolveForDecision(pending.contextId)
    ).resolves.toEqual({
      status: 'READY',
      embedding: [0.1, 0.2, 0.3],
      source: 'L2',
    });
    const redisReadsAfterL2 = redis.get.mock.calls.length;
    await expect(
      service.resolveForDecision(pending.contextId)
    ).resolves.toEqual({
      status: 'READY',
      embedding: [0.1, 0.2, 0.3],
      source: 'L1',
    });
    expect(redis.get.mock.calls.length).toBe(redisReadsAfterL2);
    expect(metrics.recordRtbContextCache).toHaveBeenCalledWith('l2_hit');
    expect(metrics.recordRtbContextCache).toHaveBeenCalledWith('l1_hit');
    const repeated = await service.observe({
      title: 'title',
      body: 'body',
      tags: ['tag'],
    });
    expect(repeated.status).toBe('READY');
    expect(queue.add).toHaveBeenCalledTimes(1);
  });

  it('3C-U3: queue failure records FAILED and releases the job lock', async () => {
    const harness = buildHarness();
    harness.queue.add.mockRejectedValue(new Error('queue down'));

    const failed = await harness.service.observe({
      title: 'title',
      tags: [],
    });

    expect(failed.status).toBe('FAILED');
    expect(harness.redis.del).toHaveBeenCalledTimes(1);
    expect(harness.metrics.recordRtbContextJob).toHaveBeenCalledWith('failed');
  });

  it('3C-U4: model version changes isolate the stored state', async () => {
    const redis = buildRedis();
    const v1 = buildHarness({ redis, modelVersion: 'model-v1' });
    const v2 = buildHarness({ redis, modelVersion: 'model-v2' });

    const first = await v1.service.observe({ title: 'same', tags: [] });
    const second = await v2.service.observe({ title: 'same', tags: [] });

    expect(second.contextId).toBe(first.contextId);
    expect(v1.queue.add).toHaveBeenCalledTimes(1);
    expect(v2.queue.add).toHaveBeenCalledTimes(1);
  });

  it('3D-U1: unknown or malformed context IDs resolve as MISS', async () => {
    const { service } = buildHarness();

    await expect(service.resolveForDecision('invalid')).resolves.toEqual({
      status: 'MISS',
    });
    await expect(
      service.resolveForDecision(`ctx_${'f'.repeat(64)}`)
    ).resolves.toEqual({ status: 'MISS' });
  });

  it('3D-U2: READY L1 is bounded by LRU size', async () => {
    const harness = buildHarness({
      config: { RTB_CONTEXT_L1_MAX_SIZE: '1' },
    });

    const first = await harness.service.observe({ title: 'first', tags: [] });
    const firstJob = harness.queue.add.mock
      .calls[0][1] as ContextEmbeddingJobData;
    await harness.service.completeJob(firstJob, [0.1, 0.2, 0.3]);
    await harness.service.resolveForDecision(first.contextId);

    const second = await harness.service.observe({ title: 'second', tags: [] });
    const secondJob = harness.queue.add.mock
      .calls[1][1] as ContextEmbeddingJobData;
    await harness.service.completeJob(secondJob, [0.4, 0.5, 0.6]);
    await harness.service.resolveForDecision(second.contextId);

    expect(harness.service.getReadyL1Size()).toBe(1);
    expect(harness.metrics.recordRtbContextCache).toHaveBeenCalledWith(
      'eviction'
    );
    await expect(
      harness.service.resolveForDecision(first.contextId)
    ).resolves.toMatchObject({ status: 'READY', source: 'L2' });
  });

  it('3D-U3: expired READY L1 falls back to Redis L2', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-07-10T00:00:00Z'));
    const harness = buildHarness({
      config: { RTB_CONTEXT_L1_TTL_MS: '10' },
    });
    const pending = await harness.service.observe({ title: 'ttl', tags: [] });
    const job = harness.queue.add.mock.calls[0][1] as ContextEmbeddingJobData;
    await harness.service.completeJob(job, [0.1, 0.2, 0.3]);
    await harness.service.resolveForDecision(pending.contextId);
    const readsAfterFirst = harness.redis.get.mock.calls.length;

    jest.advanceTimersByTime(11);
    await expect(
      harness.service.resolveForDecision(pending.contextId)
    ).resolves.toMatchObject({ status: 'READY', source: 'L2' });
    expect(harness.redis.get.mock.calls.length).toBe(readsAfterFirst + 1);
  });
});
