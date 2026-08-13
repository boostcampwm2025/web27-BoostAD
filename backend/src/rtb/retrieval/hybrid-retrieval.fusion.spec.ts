import { fuseHybridRankings } from './hybrid-retrieval.fusion';

describe('fuseHybridRankings', () => {
  it('unions dense and sparse candidates while preserving source evidence', () => {
    const result = fuseHybridRankings(
      [
        { campaignId: 'dense-only', rawScore: 0.91 },
        { campaignId: 'shared', rawScore: 0.82 },
      ],
      [
        { campaignId: 'sparse-only', rawScore: 300 },
        { campaignId: 'shared', rawScore: 210 },
      ]
    );

    expect(result.map((candidate) => candidate.campaignId)).toEqual([
      'shared',
      'dense-only',
    ]);
    expect(result[0]).toMatchObject({
      campaignId: 'shared',
      matchedSourceCount: 2,
      dense: { rank: 2, rawScore: 0.82 },
      sparse: { rank: 2, rawScore: 210 },
    });
  });

  it('uses source weights without normalizing incomparable raw scores', () => {
    const result = fuseHybridRankings(
      [{ campaignId: 'dense', rawScore: 0.1 }],
      [{ campaignId: 'sparse', rawScore: 999_999 }],
      { denseWeight: 2, sparseWeight: 1, limit: 2 }
    );

    expect(result.map((candidate) => candidate.campaignId)).toEqual([
      'dense',
      'sparse',
    ]);
  });

  it('ignores duplicate hits after the first rank from the same source', () => {
    const result = fuseHybridRankings(
      [
        { campaignId: 'a', rawScore: 0.9 },
        { campaignId: 'a', rawScore: 0.8 },
      ],
      [],
      { limit: 10 }
    );

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      campaignId: 'a',
      matchedSourceCount: 1,
      dense: { rank: 1, rawScore: 0.9 },
    });
  });

  it('applies a deterministic campaign id tie-break', () => {
    const result = fuseHybridRankings(
      [{ campaignId: 'b' }],
      [{ campaignId: 'a' }],
      { limit: 2 }
    );

    expect(result.map((candidate) => candidate.campaignId)).toEqual(['a', 'b']);
  });

  it('does not mutate source rankings and respects limit zero', () => {
    const dense = Object.freeze([{ campaignId: 'a', rawScore: 0.7 }]);
    const sparse = Object.freeze([{ campaignId: 'b', rawScore: 10 }]);

    expect(fuseHybridRankings(dense, sparse, { limit: 0 })).toEqual([]);
    expect(dense).toEqual([{ campaignId: 'a', rawScore: 0.7 }]);
    expect(sparse).toEqual([{ campaignId: 'b', rawScore: 10 }]);
  });

  it('rejects invalid configuration and hit data', () => {
    expect(() => fuseHybridRankings([], [], { rrfK: 0 })).toThrow(
      'rrfK must be a positive finite number'
    );
    expect(() =>
      fuseHybridRankings([{ campaignId: '', rawScore: 1 }], [])
    ).toThrow('dense[0] requires a campaignId');
    expect(() =>
      fuseHybridRankings([{ campaignId: 'a', rawScore: Number.NaN }], [])
    ).toThrow('dense[0] rawScore must be finite');
  });
});
