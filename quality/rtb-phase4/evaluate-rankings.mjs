#!/usr/bin/env node
import { readFile, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

function mean(values) {
  return values.length === 0
    ? 0
    : values.reduce((sum, value) => sum + value, 0) / values.length;
}

function round(value) {
  return Number(value.toFixed(6));
}

function dcg(relevances) {
  return relevances.reduce(
    (sum, relevance, index) =>
      sum + (2 ** relevance - 1) / Math.log2(index + 2),
    0
  );
}

function candidateKey(candidate) {
  return typeof candidate === 'string' ? candidate : candidate?.campaignKey;
}

function groupJudgments(qrels) {
  const judgments = new Map();
  for (const qrel of qrels) {
    if (!judgments.has(qrel.contentId)) {
      judgments.set(qrel.contentId, new Map());
    }
    const contentJudgments = judgments.get(qrel.contentId);
    if (contentJudgments.has(qrel.campaignKey)) {
      throw new Error(`Duplicate qrel: ${qrel.contentId}/${qrel.campaignKey}`);
    }
    contentJudgments.set(qrel.campaignKey, qrel);
  }
  return judgments;
}

export function evaluateRankings({
  qrels,
  rankings,
  k = 10,
  relevantThreshold = 2,
}) {
  const judgments = groupJudgments(qrels);
  const rankingByContent = new Map();
  const validationErrors = [];

  for (const ranking of rankings) {
    if (!ranking?.contentId || !Array.isArray(ranking.candidates)) {
      validationErrors.push('Ranking must contain contentId and candidates[]');
      continue;
    }
    if (rankingByContent.has(ranking.contentId)) {
      validationErrors.push(`Duplicate ranking: ${ranking.contentId}`);
      continue;
    }
    rankingByContent.set(ranking.contentId, ranking);
  }

  const perQuery = [];
  for (const [contentId, contentJudgments] of judgments.entries()) {
    const ranking = rankingByContent.get(contentId);
    if (!ranking) {
      validationErrors.push(`Missing ranking: ${contentId}`);
    }

    const keys = (ranking?.candidates ?? []).map(candidateKey);
    const seen = new Set();
    for (const key of keys) {
      if (!key) {
        validationErrors.push(`Empty campaignKey: ${contentId}`);
        continue;
      }
      if (seen.has(key)) {
        validationErrors.push(`Duplicate candidate: ${contentId}/${key}`);
      }
      seen.add(key);
      if (!contentJudgments.has(key)) {
        validationErrors.push(`Unknown campaignKey: ${contentId}/${key}`);
      }
    }

    const topKeys = keys.slice(0, k);
    const topJudgments = topKeys.map(
      (key) => contentJudgments.get(key) ?? { relevance: 0, eligible: false }
    );
    const relevantCampaigns = [...contentJudgments.values()].filter(
      (qrel) => qrel.eligible && qrel.relevance >= relevantThreshold
    );
    const hasExpectedCandidate = relevantCampaigns.length > 0;
    const relevantRetrieved = topJudgments.filter(
      (qrel) => qrel.eligible && qrel.relevance >= relevantThreshold
    ).length;
    const idealRelevances = [...contentJudgments.values()]
      .filter((qrel) => qrel.eligible)
      .map((qrel) => qrel.relevance)
      .sort((left, right) => right - left)
      .slice(0, k);
    const actualRelevances = topJudgments.map((qrel) => qrel.relevance);
    const idealDcg = dcg(idealRelevances);
    const firstRelevantIndex = topJudgments.findIndex(
      (qrel) => qrel.eligible && qrel.relevance >= relevantThreshold
    );
    const winner = topJudgments[0] ?? null;

    perQuery.push({
      contentId,
      hasExpectedCandidate,
      returnedCount: keys.length,
      topKeys,
      winnerKey: topKeys[0] ?? null,
      winnerRelevance: winner?.relevance ?? 0,
      winnerEligible: winner?.eligible ?? true,
      recallAtK: hasExpectedCandidate
        ? relevantRetrieved / relevantCampaigns.length
        : null,
      precisionAtK: hasExpectedCandidate ? relevantRetrieved / k : null,
      ndcgAtK: hasExpectedCandidate
        ? idealDcg === 0
          ? 0
          : dcg(actualRelevances) / idealDcg
        : null,
      reciprocalRank: hasExpectedCandidate
        ? firstRelevantIndex < 0
          ? 0
          : 1 / (firstRelevantIndex + 1)
        : null,
      acceptableWinner:
        hasExpectedCandidate &&
        winner?.eligible === true &&
        winner.relevance >= relevantThreshold,
      noCandidate: keys.length === 0,
      eligibilityViolation: topJudgments.some((qrel) => !qrel.eligible),
    });
  }

  for (const contentId of rankingByContent.keys()) {
    if (!judgments.has(contentId)) {
      validationErrors.push(`Unknown contentId: ${contentId}`);
    }
  }

  const positiveQueries = perQuery.filter(
    (query) => query.hasExpectedCandidate
  );
  const nullQueries = perQuery.filter((query) => !query.hasExpectedCandidate);
  const summary = {
    k,
    queryCount: perQuery.length,
    positiveQueryCount: positiveQueries.length,
    nullQueryCount: nullQueries.length,
    recallAtK: round(mean(positiveQueries.map((query) => query.recallAtK))),
    precisionAtK: round(
      mean(positiveQueries.map((query) => query.precisionAtK))
    ),
    ndcgAtK: round(mean(positiveQueries.map((query) => query.ndcgAtK))),
    meanReciprocalRank: round(
      mean(positiveQueries.map((query) => query.reciprocalRank))
    ),
    acceptableWinnerRate: round(
      mean(positiveQueries.map((query) => Number(query.acceptableWinner)))
    ),
    averageWinnerRelevance: round(
      mean(positiveQueries.map((query) => query.winnerRelevance))
    ),
    positiveNoCandidateRate: round(
      mean(positiveQueries.map((query) => Number(query.noCandidate)))
    ),
    nullQuerySuppressionRate: round(
      mean(nullQueries.map((query) => Number(query.noCandidate)))
    ),
    falsePositiveOnNullRate: round(
      mean(nullQueries.map((query) => Number(!query.noCandidate)))
    ),
    eligibilityViolationCount: perQuery.filter(
      (query) => query.eligibilityViolation
    ).length,
  };

  return {
    valid: validationErrors.length === 0,
    validationErrors,
    summary,
    perQuery,
  };
}

export function compareEvaluations(control, candidate, k = 10) {
  const controlQueries = new Map(
    control.perQuery.map((query) => [query.contentId, query])
  );
  const candidateQueries = new Map(
    candidate.perQuery.map((query) => [query.contentId, query])
  );
  const sharedIds = [...controlQueries.keys()].filter((contentId) =>
    candidateQueries.has(contentId)
  );

  let winnerAgreement = 0;
  let changedWinnerImproved = 0;
  let changedWinnerRegressed = 0;
  let changedWinnerTied = 0;
  const overlaps = [];

  for (const contentId of sharedIds) {
    const left = controlQueries.get(contentId);
    const right = candidateQueries.get(contentId);
    if (left.winnerKey === right.winnerKey) {
      winnerAgreement += 1;
    } else if (right.winnerRelevance > left.winnerRelevance) {
      changedWinnerImproved += 1;
    } else if (right.winnerRelevance < left.winnerRelevance) {
      changedWinnerRegressed += 1;
    } else {
      changedWinnerTied += 1;
    }

    if (left.topKeys.length === 0 && right.topKeys.length === 0) {
      overlaps.push(1);
    } else {
      const rightKeys = new Set(right.topKeys.slice(0, k));
      const intersection = left.topKeys
        .slice(0, k)
        .filter((key) => rightKeys.has(key)).length;
      overlaps.push(intersection / k);
    }
  }

  const deltas = {
    recallAtK: round(candidate.summary.recallAtK - control.summary.recallAtK),
    precisionAtK: round(
      candidate.summary.precisionAtK - control.summary.precisionAtK
    ),
    ndcgAtK: round(candidate.summary.ndcgAtK - control.summary.ndcgAtK),
    meanReciprocalRank: round(
      candidate.summary.meanReciprocalRank - control.summary.meanReciprocalRank
    ),
    acceptableWinnerRate: round(
      candidate.summary.acceptableWinnerRate -
        control.summary.acceptableWinnerRate
    ),
    averageWinnerRelevance: round(
      candidate.summary.averageWinnerRelevance -
        control.summary.averageWinnerRelevance
    ),
    positiveNoCandidateRate: round(
      candidate.summary.positiveNoCandidateRate -
        control.summary.positiveNoCandidateRate
    ),
    falsePositiveOnNullRate: round(
      candidate.summary.falsePositiveOnNullRate -
        control.summary.falsePositiveOnNullRate
    ),
  };
  const gates = {
    validInputs: control.valid && candidate.valid,
    recallMaintained: deltas.recallAtK >= 0,
    ndcgMaintained: deltas.ndcgAtK >= 0,
    acceptableWinnerMaintained: deltas.acceptableWinnerRate >= 0,
    positiveNoCandidateNotWorse: deltas.positiveNoCandidateRate <= 0,
    nullFalsePositiveNotWorse: deltas.falsePositiveOnNullRate <= 0,
    changedWinnerQualityNotWorse:
      changedWinnerImproved >= changedWinnerRegressed,
    eligibilityPreserved: candidate.summary.eligibilityViolationCount === 0,
  };

  return {
    valid:
      sharedIds.length === control.perQuery.length &&
      control.valid &&
      candidate.valid,
    sharedQueryCount: sharedIds.length,
    winnerAgreementRate: round(winnerAgreement / Math.max(sharedIds.length, 1)),
    meanTopKOverlap: round(mean(overlaps)),
    changedWinners: {
      improved: changedWinnerImproved,
      regressed: changedWinnerRegressed,
      tied: changedWinnerTied,
    },
    deltas,
    gates,
    productPass: Object.values(gates).every(Boolean),
  };
}

export function parseJsonLines(value) {
  return value
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line, index) => {
      try {
        return JSON.parse(line);
      } catch (error) {
        throw new Error(`Invalid JSONL at line ${index + 1}: ${error.message}`);
      }
    });
}

function argument(name, required = false) {
  const index = process.argv.indexOf(name);
  const value = index >= 0 ? process.argv[index + 1] : undefined;
  if (required && !value) {
    throw new Error(`Missing required argument: ${name}`);
  }
  return value;
}

async function main() {
  const qrelsPath = argument('--qrels', true);
  const controlPath = argument('--control', true);
  const candidatePath = argument('--candidate', true);
  const outputPath = argument('--output');
  const k = Number.parseInt(argument('--k') ?? '10', 10);
  if (!Number.isInteger(k) || k <= 0) {
    throw new Error('--k must be a positive integer');
  }

  const [qrelsText, controlText, candidateText] = await Promise.all([
    readFile(qrelsPath, 'utf8'),
    readFile(controlPath, 'utf8'),
    readFile(candidatePath, 'utf8'),
  ]);
  const qrels = parseJsonLines(qrelsText);
  const control = evaluateRankings({
    qrels,
    rankings: parseJsonLines(controlText),
    k,
  });
  const candidate = evaluateRankings({
    qrels,
    rankings: parseJsonLines(candidateText),
    k,
  });
  const report = {
    control: { valid: control.valid, summary: control.summary },
    candidate: { valid: candidate.valid, summary: candidate.summary },
    comparison: compareEvaluations(control, candidate, k),
    validationErrors: {
      control: control.validationErrors,
      candidate: candidate.validationErrors,
    },
  };
  const serialized = `${JSON.stringify(report, null, 2)}\n`;

  if (outputPath) {
    await writeFile(outputPath, serialized, 'utf8');
  }
  process.stdout.write(serialized);
  if (!report.comparison.valid) {
    process.exitCode = 2;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
