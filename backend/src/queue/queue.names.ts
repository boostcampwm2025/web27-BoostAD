import 'dotenv/config';
import { resolveEmbeddingProfile } from '../rtb/ml/embedding-profile';

export function resolveEmbeddingQueueName(
  rawProfile?: string,
  explicitQueueName?: string
): string {
  const explicitName = explicitQueueName?.trim();
  if (explicitName) return explicitName;

  const embeddingProfile = resolveEmbeddingProfile(rawProfile);
  return embeddingProfile.name === 'legacy_minilm'
    ? 'embedding-queue'
    : `embedding-queue-${embeddingProfile.name}`;
}

export const EMBEDDING_QUEUE_NAME = resolveEmbeddingQueueName(
  process.env.RTB_EMBEDDING_PROFILE,
  process.env.RTB_EMBEDDING_QUEUE_NAME
);
