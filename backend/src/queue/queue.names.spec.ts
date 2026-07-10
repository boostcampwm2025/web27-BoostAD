import { resolveEmbeddingQueueName } from './queue.names';

describe('embedding queue namespace', () => {
  it('keeps the historical queue name for the rollback profile', () => {
    expect(resolveEmbeddingQueueName('legacy_minilm')).toBe('embedding-queue');
  });

  it('isolates E5 jobs from legacy workers', () => {
    expect(resolveEmbeddingQueueName('multilingual_e5_small')).toBe(
      'embedding-queue-multilingual_e5_small'
    );
  });

  it('allows an explicit queue name for controlled migrations', () => {
    expect(
      resolveEmbeddingQueueName(
        'multilingual_e5_small',
        'embedding-queue-e5-canary'
      )
    ).toBe('embedding-queue-e5-canary');
  });
});
