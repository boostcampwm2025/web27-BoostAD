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

  it('3D-U4: L1 hit refreshes recency so oldest unused entry is evicted', async () => {
    const harness = buildHarness({
      config: { RTB_CONTEXT_L1_MAX_SIZE: '2' },
    });
    const makeReady = async (title: string, embedding: number[]) => {
      const pending = await harness.service.observe({ title, tags: [] });
      const job = harness.queue.add.mock.calls.at(-1)?.[1] as ContextEmbeddingJobData;
      await harness.service.completeJob(job, embedding);
      await harness.service.resolveForDecision(pending.contextId);
      return pending.contextId;
    };

    const firstId = await makeReady('first', [0.1, 0.2, 0.3]);
    const secondId = await makeReady('second', [0.4, 0.5, 0.6]);
    // refresh first so second becomes oldest
    await harness.service.resolveForDecision(firstId);
    await makeReady('third', [0.7, 0.8, 0.9]);

    expect(harness.service.getReadyL1Size()).toBe(2);
    await expect(
      harness.service.resolveForDecision(firstId)
    ).resolves.toMatchObject({ status: 'READY', source: 'L1' });
    await expect(
      harness.service.resolveForDecision(secondId)
    ).resolves.toMatchObject({ status: 'READY', source: 'L2' });
  });

  it('3D-U5: invalid READY payload is not promoted to L1', async () => {
    const harness = buildHarness();
    const pending = await harness.service.observe({ title: 'bad', tags: [] });
    const stateKey = `context-embedding:model-v1:${pending.contentHash}`;
    harness.redis.store.set(
      stateKey,
      JSON.stringify({
        status: 'READY',
        contextId: pending.contextId,
        contentHash: pending.contentHash,
        modelVersion: 'model-v1',
        embedding: [0.1, Number.NaN, 0.3],
        updatedAt: new Date().toISOString(),
      })
    );

    await expect(
      harness.service.resolveForDecision(pending.contextId)
    ).resolves.toEqual({ status: 'ERROR' });
    expect(harness.service.getReadyL1Size()).toBe(0);
  });

  it('3D-U6: PENDING FAILED and MISS never populate READY L1', async () => {
    const harness = buildHarness();
    const pending = await harness.service.observe({ title: 'p', tags: [] });
    expect(harness.service.getReadyL1Size()).toBe(0);

    await expect(
      harness.service.resolveForDecision(pending.contextId)
    ).resolves.toEqual({ status: 'PENDING' });
    expect(harness.service.getReadyL1Size()).toBe(0);

    const job = harness.queue.add.mock.calls[0][1] as ContextEmbeddingJobData;
    await harness.service.failJob(job, new Error('boom'));
    await expect(
      harness.service.resolveForDecision(pending.contextId)
    ).resolves.toEqual({ status: 'FAILED' });
    expect(harness.service.getReadyL1Size()).toBe(0);

    await expect(
      harness.service.resolveForDecision(`ctx_${'c'.repeat(64)}`)
    ).resolves.toEqual({ status: 'MISS' });
    expect(harness.service.getReadyL1Size()).toBe(0);
  });

  it('3C-U5: body beyond 8000 chars is truncated for the content hash', async () => {
    const harness = buildHarness({
      config: { RTB_CONTEXT_MAX_BODY_CHARS: '8' },
    });
    const first = await harness.service.observe({
      title: 't',
      body: 'abcdefghXXXX',
      tags: [],
    });
    const second = await harness.service.observe({
      title: 't',
      body: 'abcdefghYYYY',
      tags: [],
    });
    const third = await harness.service.observe({
      title: 't',
      body: 'abcdZZZZ',
      tags: [],
    });

    expect(second.contentHash).toBe(first.contentHash);
    expect(third.contentHash).not.toBe(first.contentHash);
    expect(harness.queue.add).toHaveBeenCalledTimes(2);
  });

  it('3C-U6: Unicode NFC variants share one hash', async () => {
    const { service, queue } = buildHarness();
    const first = await service.observe({
      title: 'Cafe\u0301',
      body: '',
      tags: ['react'],
    });
    const second = await service.observe({
      title: 'Café',
      body: '',
      tags: ['react'],
    });
    expect(second.contentHash).toBe(first.contentHash);
    expect(queue.add).toHaveBeenCalledTimes(1);
  });

  it('3C-U7: concurrent observes enqueue a single job', async () => {
    const { service, queue, metrics } = buildHarness();
    const results = await Promise.all(
      Array.from({ length: 8 }, () =>
        service.observe({ title: 'burst', body: 'same', tags: ['a'] })
      )
    );
    expect(new Set(results.map((item) => item.contextId)).size).toBe(1);
    expect(queue.add).toHaveBeenCalledTimes(1);
    expect(metrics.recordRtbContextJob).toHaveBeenCalledWith('deduplicated');
  });

  it('3C-U8: FAILED observe can be retried after lock release', async () => {
    const harness = buildHarness();
    harness.queue.add
      .mockRejectedValueOnce(new Error('queue down'))
      .mockResolvedValueOnce({ id: 'job-2' });

    const failed = await harness.service.observe({ title: 'retry', tags: [] });
    expect(failed.status).toBe('FAILED');

    const retried = await harness.service.observe({ title: 'retry', tags: [] });
    expect(retried.status).toBe('PENDING');
    expect(harness.queue.add).toHaveBeenCalledTimes(2);
  });

  it('3C-U9: PENDING re-observe during worker does not enqueue again', async () => {
    const { service, queue, metrics } = buildHarness();
    const first = await service.observe({ title: 'lock', tags: [] });
    expect(first.status).toBe('PENDING');
    const second = await service.observe({ title: 'lock', tags: [] });
    expect(second.status).toBe('PENDING');
    expect(queue.add).toHaveBeenCalledTimes(1);
    expect(metrics.recordRtbContextJob).toHaveBeenCalledWith('deduplicated');
  });
});
