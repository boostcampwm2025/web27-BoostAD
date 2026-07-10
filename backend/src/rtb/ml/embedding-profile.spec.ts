import {
  resolveEmbeddingProfile,
  toEmbeddingNamespace,
} from './embedding-profile';

describe('embedding profile', () => {
  it('keeps the current MiniLM contract as the default rollback profile', () => {
    const profile = resolveEmbeddingProfile();

    expect(profile.name).toBe('legacy_minilm');
    expect(profile.modelId).toBe('Xenova/all-MiniLM-L6-v2');
    expect(profile.dimension).toBe(384);
    expect(profile.formatInput('  Café   React  ', 'query')).toBe('Café React');
    expect(profile.formatInput('campaign text', 'passage')).toBe(
      'campaign text'
    );
  });

  it('applies the E5 query and passage prefixes after canonicalization', () => {
    const profile = resolveEmbeddingProfile('multilingual_e5_small');

    expect(profile.modelId).toBe('Xenova/multilingual-e5-small');
    expect(profile.dimension).toBe(384);
    expect(profile.formatInput('  서버\n  장애  ', 'query')).toBe(
      'query: 서버 장애'
    );
    expect(profile.formatInput('  광고\t설명 ', 'passage')).toBe(
      'passage: 광고 설명'
    );
  });

  it('rejects an unknown profile instead of silently mixing vector spaces', () => {
    expect(() => resolveEmbeddingProfile('typo-model')).toThrow(
      '지원하지 않는 RTB_EMBEDDING_PROFILE'
    );
  });

  it('creates a deterministic Redis-safe namespace from model version', () => {
    expect(
      toEmbeddingNamespace(
        'Xenova/multilingual-e5-small@retrieval-v1-mean-normalized'
      )
    ).toBe('xenova-multilingual-e5-small-retrieval-v1-mean-normalized');
  });
});
