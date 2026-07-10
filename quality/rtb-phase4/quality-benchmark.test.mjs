import assert from 'node:assert/strict';
import test from 'node:test';
import { buildDataset } from './dataset.mjs';
import {
  compareEvaluations,
  evaluateRankings,
  summarizeEvaluationBy,
} from './evaluate-rankings.mjs';
import {
  chunk,
  resolveRetrievalModes,
  toCampaignPayload,
  toContentPayload,
} from './run-ranking-extraction.mjs';

test('dataset generation is deterministic and covers the intended matrix', () => {
  const first = buildDataset();
  const second = buildDataset();

  assert.equal(first.manifest.counts.campaigns, 50);
  assert.equal(first.manifest.counts.contents, 130);
  assert.equal(first.manifest.counts.qrels, 6500);
  assert.equal(first.manifest.counts.noMatch, 10);
  assert.deepEqual(first.manifest.sha256, second.manifest.sha256);
  assert.deepEqual(first.manifest.relevanceDistribution, {
    0: 4100,
    1: 1200,
    2: 930,
    3: 270,
  });
});

test('every lexical trap has an exact-tag hard negative in the campaign catalog', () => {
  const dataset = buildDataset();
  const traps = dataset.contents.filter(
    (content) => content.scenario === 'lexical-trap'
  );

  for (const content of traps) {
    const hardNegatives = dataset.campaigns.filter(
      (campaign) =>
        campaign.theme === content.trapTheme &&
        campaign.tags.some((tag) => content.tags.includes(tag))
    );
    assert.ok(hardNegatives.length > 0, content.contentId);
    for (const campaign of hardNegatives) {
      const qrel = dataset.qrels.find(
        (entry) =>
          entry.contentId === content.contentId &&
          entry.campaignKey === campaign.campaignKey
      );
      assert.equal(qrel.relevance, 0);
    }
  }
});

test('an oracle ranking scores perfectly on positive and no-match queries', () => {
  const dataset = buildDataset();
  const qrelsByContent = new Map();
  for (const qrel of dataset.qrels) {
    if (!qrelsByContent.has(qrel.contentId)) {
      qrelsByContent.set(qrel.contentId, []);
    }
    qrelsByContent.get(qrel.contentId).push(qrel);
  }
  const rankings = [...qrelsByContent.entries()].map(
    ([contentId, judgments]) => ({
      contentId,
      candidates: judgments.some((qrel) => qrel.relevance >= 2)
        ? [...judgments]
            .sort((left, right) => right.relevance - left.relevance)
            .slice(0, 10)
            .map((qrel) => qrel.campaignKey)
        : [],
    })
  );
  const result = evaluateRankings({ qrels: dataset.qrels, rankings, k: 10 });

  assert.equal(result.valid, true);
  assert.equal(result.summary.recallAtK, 1);
  assert.equal(result.summary.ndcgAtK, 1);
  assert.equal(result.summary.acceptableWinnerRate, 1);
  assert.equal(result.summary.nullQuerySuppressionRate, 1);
});

test('comparison reports a relevance regression when the candidate winner is worse', () => {
  const qrels = [
    {
      contentId: 'content-1',
      campaignKey: 'best',
      relevance: 3,
      eligible: true,
    },
    {
      contentId: 'content-1',
      campaignKey: 'okay',
      relevance: 2,
      eligible: true,
    },
    {
      contentId: 'content-1',
      campaignKey: 'bad',
      relevance: 0,
      eligible: true,
    },
    {
      contentId: 'content-null',
      campaignKey: 'best',
      relevance: 0,
      eligible: true,
    },
    {
      contentId: 'content-null',
      campaignKey: 'okay',
      relevance: 0,
      eligible: true,
    },
    {
      contentId: 'content-null',
      campaignKey: 'bad',
      relevance: 0,
      eligible: true,
    },
  ];
  const control = evaluateRankings({
    qrels,
    rankings: [
      { contentId: 'content-1', candidates: ['best', 'okay', 'bad'] },
      { contentId: 'content-null', candidates: [] },
    ],
    k: 3,
  });
  const candidate = evaluateRankings({
    qrels,
    rankings: [
      { contentId: 'content-1', candidates: ['bad', 'okay', 'best'] },
      { contentId: 'content-null', candidates: ['bad'] },
    ],
    k: 3,
  });
  const comparison = compareEvaluations(control, candidate, 3);

  assert.equal(control.valid, true);
  assert.equal(candidate.valid, true);
  assert.equal(comparison.changedWinners.regressed, 1);
  assert.ok(comparison.deltas.ndcgAtK < 0);
  assert.ok(comparison.deltas.falsePositiveOnNullRate > 0);
  assert.equal(comparison.productPass, false);
});

test('duplicate and unknown candidates make a ranking invalid', () => {
  const result = evaluateRankings({
    qrels: [
      {
        contentId: 'content-1',
        campaignKey: 'known',
        relevance: 3,
        eligible: true,
      },
    ],
    rankings: [
      { contentId: 'content-1', candidates: ['known', 'known', 'unknown'] },
    ],
  });

  assert.equal(result.valid, false);
  assert.ok(
    result.validationErrors.some((error) =>
      error.includes('Duplicate candidate')
    )
  );
  assert.ok(
    result.validationErrors.some((error) =>
      error.includes('Unknown campaignKey')
    )
  );
});

test('ranking runner strips dataset-only fields from strict API payloads', () => {
  const dataset = buildDataset();
  const campaignPayload = toCampaignPayload(dataset.campaigns[0]);
  const contentPayload = toContentPayload(dataset.contents[0]);

  assert.deepEqual(Object.keys(campaignPayload), [
    'campaignKey',
    'title',
    'content',
    'tags',
  ]);
  assert.deepEqual(Object.keys(contentPayload), [
    'contentId',
    'title',
    'body',
    'tags',
  ]);
  assert.equal('theme' in campaignPayload, false);
  assert.equal('split' in contentPayload, false);
});

test('ranking runner creates complete deterministic batches', () => {
  assert.deepEqual(chunk([1, 2, 3, 4, 5], 2), [[1, 2], [3, 4], [5]]);
  assert.throws(() => chunk([1], 0), /positive integer/);
});

test('ranking runner resolves paired extraction in one loaded session', () => {
  assert.deepEqual(resolveRetrievalModes('paired'), [
    'dense_only',
    'hybrid_shadow',
  ]);
  assert.deepEqual(resolveRetrievalModes('dense_only'), ['dense_only']);
  assert.throws(() => resolveRetrievalModes('unknown'), /paired/);
});

test('quality evaluation reports scenario-level semantic failures', () => {
  const dataset = buildDataset();
  const rankings = dataset.contents.map((content) => ({
    contentId: content.contentId,
    candidates: [],
  }));
  const evaluation = evaluateRankings({
    qrels: dataset.qrels,
    rankings,
    k: 10,
  });
  const scenarios = summarizeEvaluationBy(
    dataset.contents,
    evaluation,
    'scenario'
  );

  assert.equal(scenarios['semantic-paraphrase'].queryCount, 10);
  assert.equal(scenarios['semantic-paraphrase'].positiveNoCandidateRate, 1);
  assert.equal(scenarios['no-match'].falsePositiveOnNullRate, 0);
});
