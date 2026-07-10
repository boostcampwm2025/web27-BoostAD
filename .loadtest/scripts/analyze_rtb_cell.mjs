import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const [summaryArg, beforeArg, afterArg, outputArg] = process.argv.slice(2);
if (!summaryArg || !beforeArg || !afterArg || !outputArg) {
  throw new Error(
    'usage: node analyze_rtb_cell.mjs <summary.json> <metrics-before> <metrics-after> <output.json>'
  );
}

const summary = JSON.parse(readFileSync(resolve(summaryArg), 'utf8'));
const before = parsePrometheus(readFileSync(resolve(beforeArg), 'utf8'));
const after = parsePrometheus(readFileSync(resolve(afterArg), 'utf8'));

const iterations = metricValue(summary, 'iterations', 'count') ?? 0;
const businessErrorRate =
  metricValue(summary, 'business_errors', 'rate') ??
  metricValue(summary, 'business_errors', 'value') ??
  null;
const reservationRejected = counterDelta(
  before,
  after,
  'boostad_rtb_reservation_failures_total',
  { reason: 'rejected' }
);

const result = {
  k6: {
    iterations,
    iterationRate: metricValue(summary, 'iterations', 'rate'),
    droppedIterations:
      metricValue(summary, 'dropped_iterations', 'count') ?? 0,
    transportErrorRate:
      metricValue(summary, 'transport_errors', 'rate') ??
      metricValue(summary, 'transport_errors', 'value') ??
      null,
    businessErrorRate,
    businessSuccessRate:
      metricValue(summary, 'business_success', 'rate') ??
      metricValue(summary, 'business_success', 'value') ??
      null,
    http: trendValues(summary, 'http_req_duration'),
    successOnly: trendValues(summary, 'decision_success_duration'),
  },
  server: {
    requests: {
      success: counterDeltaByLabel(
        before,
        after,
        'boostad_rtb_requests_total',
        'result',
        'success'
      ),
      fallback: counterDeltaByLabel(
        before,
        after,
        'boostad_rtb_requests_total',
        'result',
        'fallback'
      ),
      error: counterDeltaByLabel(
        before,
        after,
        'boostad_rtb_requests_total',
        'result',
        'error'
      ),
    },
    fallbackEntries: counterDeltaByMetric(
      before,
      after,
      'boostad_rtb_fallback_total'
    ),
    reservationRejected,
  },
  labels: {
    budgetContaminated: reservationRejected > 0,
    evidence: 'PROVISIONAL',
  },
};

writeFileSync(resolve(outputArg), `${JSON.stringify(result, null, 2)}\n`);
process.stdout.write(`${JSON.stringify(result)}\n`);

function metricValue(k6Summary, metricName, valueName) {
  const metric = k6Summary.metrics?.[metricName];
  return metric?.values?.[valueName] ?? metric?.[valueName] ?? null;
}

function trendValues(k6Summary, metricName) {
  const metric = k6Summary.metrics?.[metricName];
  const values = metric?.values ?? metric;
  if (!values) {
    return null;
  }
  return {
    avg: values.avg ?? null,
    min: values.min ?? null,
    med: values.med ?? null,
    p90: values['p(90)'] ?? null,
    p95: values['p(95)'] ?? null,
    p99: values['p(99)'] ?? null,
    max: values.max ?? null,
  };
}

function parsePrometheus(text) {
  const samples = [];
  for (const line of text.split('\n')) {
    if (!line || line.startsWith('#')) {
      continue;
    }
    const match = line.match(
      /^([a-zA-Z_:][a-zA-Z0-9_:]*)(?:\{([^}]*)\})?\s+(-?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?)$/
    );
    if (!match) {
      continue;
    }
    samples.push({
      metric: match[1],
      labels: parseLabels(match[2] ?? ''),
      value: Number(match[3]),
    });
  }
  return samples;
}

function parseLabels(raw) {
  const labels = {};
  for (const match of raw.matchAll(/([a-zA-Z_][a-zA-Z0-9_]*)="((?:\\.|[^"])*)"/g)) {
    labels[match[1]] = match[2].replace(/\\"/g, '"').replace(/\\\\/g, '\\');
  }
  return labels;
}

function counterDelta(beforeSamples, afterSamples, metric, labels) {
  return Math.max(
    0,
    sampleSum(afterSamples, metric, labels) -
      sampleSum(beforeSamples, metric, labels)
  );
}

function counterDeltaByMetric(beforeSamples, afterSamples, metric) {
  return counterDelta(beforeSamples, afterSamples, metric, {});
}

function counterDeltaByLabel(
  beforeSamples,
  afterSamples,
  metric,
  labelName,
  labelValue
) {
  return counterDelta(beforeSamples, afterSamples, metric, {
    [labelName]: labelValue,
  });
}

function sampleSum(samples, metric, expectedLabels) {
  return samples
    .filter(
      (sample) =>
        sample.metric === metric &&
        Object.entries(expectedLabels).every(
          ([key, value]) => sample.labels[key] === value
        )
    )
    .reduce((sum, sample) => sum + sample.value, 0);
}
