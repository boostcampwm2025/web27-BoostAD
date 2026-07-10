export type RetrievalSource = 'dense' | 'sparse';

export type RetrievalHit = {
  campaignId: string;
  rawScore?: number;
};

export type RetrievalEvidence = {
  rank: number;
  rawScore?: number;
  contribution: number;
};

export type HybridRetrievalCandidate = {
  campaignId: string;
  hybridScore: number;
  matchedSourceCount: number;
  dense?: RetrievalEvidence;
  sparse?: RetrievalEvidence;
};

export type HybridFusionOptions = {
  rrfK?: number;
  denseWeight?: number;
  sparseWeight?: number;
  limit?: number;
};

const DEFAULT_RRF_K = 60;

/**
 * Dense/sparse의 raw score 척도를 직접 섞지 않고 순위 기반 RRF로 합친다.
 * 각 source의 첫 등장만 사용하며, evidence를 남겨 shadow 결과를 설명할 수 있게 한다.
 */
export function fuseHybridRankings(
  denseHits: readonly RetrievalHit[],
  sparseHits: readonly RetrievalHit[],
  options: HybridFusionOptions = {}
): HybridRetrievalCandidate[] {
  const rrfK = options.rrfK ?? DEFAULT_RRF_K;
  const denseWeight = options.denseWeight ?? 1;
  const sparseWeight = options.sparseWeight ?? 1;
  const limit = options.limit ?? Math.max(denseHits.length, sparseHits.length);

  assertPositiveFinite(rrfK, 'rrfK');
  assertNonNegativeFinite(denseWeight, 'denseWeight');
  assertNonNegativeFinite(sparseWeight, 'sparseWeight');
  assertNonNegativeInteger(limit, 'limit');

  const candidates = new Map<string, HybridRetrievalCandidate>();
  addEvidence(candidates, denseHits, 'dense', denseWeight, rrfK);
  addEvidence(candidates, sparseHits, 'sparse', sparseWeight, rrfK);

  return [...candidates.values()]
    .sort((left, right) => {
      if (right.hybridScore !== left.hybridScore) {
        return right.hybridScore - left.hybridScore;
      }
      if (right.matchedSourceCount !== left.matchedSourceCount) {
        return right.matchedSourceCount - left.matchedSourceCount;
      }
      const leftBestRank = Math.min(
        left.dense?.rank ?? Number.POSITIVE_INFINITY,
        left.sparse?.rank ?? Number.POSITIVE_INFINITY
      );
      const rightBestRank = Math.min(
        right.dense?.rank ?? Number.POSITIVE_INFINITY,
        right.sparse?.rank ?? Number.POSITIVE_INFINITY
      );
      if (leftBestRank !== rightBestRank) {
        return leftBestRank - rightBestRank;
      }
      return left.campaignId.localeCompare(right.campaignId);
    })
    .slice(0, limit);
}

function addEvidence(
  candidates: Map<string, HybridRetrievalCandidate>,
  hits: readonly RetrievalHit[],
  source: RetrievalSource,
  weight: number,
  rrfK: number
): void {
  const seen = new Set<string>();
  hits.forEach((hit, index) => {
    assertHit(hit, source, index);
    if (seen.has(hit.campaignId)) {
      return;
    }
    seen.add(hit.campaignId);

    const rank = index + 1;
    const contribution = weight / (rrfK + rank);
    const current = candidates.get(hit.campaignId) ?? {
      campaignId: hit.campaignId,
      hybridScore: 0,
      matchedSourceCount: 0,
    };
    const evidence: RetrievalEvidence = {
      rank,
      ...(hit.rawScore === undefined ? {} : { rawScore: hit.rawScore }),
      contribution,
    };

    current[source] = evidence;
    current.hybridScore += contribution;
    current.matchedSourceCount += 1;
    candidates.set(hit.campaignId, current);
  });
}

function assertHit(
  hit: RetrievalHit,
  source: RetrievalSource,
  index: number
): void {
  if (!hit?.campaignId?.trim()) {
    throw new Error(`${source}[${index}] requires a campaignId`);
  }
  if (hit.rawScore !== undefined && !Number.isFinite(hit.rawScore)) {
    throw new Error(`${source}[${index}] rawScore must be finite`);
  }
}

function assertPositiveFinite(value: number, name: string): void {
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${name} must be a positive finite number`);
  }
}

function assertNonNegativeFinite(value: number, name: string): void {
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`${name} must be a non-negative finite number`);
  }
}

function assertNonNegativeInteger(value: number, name: string): void {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${name} must be a non-negative integer`);
  }
}
