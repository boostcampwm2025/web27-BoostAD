export type EmbeddingRole = 'query' | 'passage';

export type EmbeddingProfileName = 'legacy_minilm' | 'multilingual_e5_small';

export const DEFAULT_EMBEDDING_PROFILE: EmbeddingProfileName =
  'multilingual_e5_small';

export type EmbeddingProfile = {
  name: EmbeddingProfileName;
  modelId: string;
  modelVersion: string;
  dimension: number;
  formatInput(text: string, role: EmbeddingRole): string;
};

const normalizeInput = (text: string): string =>
  text.normalize('NFC').replace(/\s+/g, ' ').trim();

const profiles: Record<EmbeddingProfileName, EmbeddingProfile> = {
  legacy_minilm: {
    name: 'legacy_minilm',
    modelId: 'Xenova/all-MiniLM-L6-v2',
    modelVersion: 'Xenova/all-MiniLM-L6-v2@request-v1-mean-normalized',
    dimension: 384,
    formatInput: (text) => normalizeInput(text),
  },
  multilingual_e5_small: {
    name: 'multilingual_e5_small',
    modelId: 'Xenova/multilingual-e5-small',
    modelVersion: 'Xenova/multilingual-e5-small@retrieval-v1-mean-normalized',
    dimension: 384,
    formatInput: (text, role) => `${role}: ${normalizeInput(text)}`,
  },
};

export function resolveEmbeddingProfile(rawProfile?: string): EmbeddingProfile {
  const name = rawProfile?.trim() || DEFAULT_EMBEDDING_PROFILE;
  if (name !== 'legacy_minilm' && name !== 'multilingual_e5_small') {
    throw new Error(`지원하지 않는 RTB_EMBEDDING_PROFILE입니다: ${name}`);
  }
  return profiles[name];
}

export function toEmbeddingNamespace(modelVersion: string): string {
  const normalized = modelVersion
    .normalize('NFC')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
  if (!normalized) {
    throw new Error('embedding model namespace를 만들 수 없습니다.');
  }
  return normalized;
}
