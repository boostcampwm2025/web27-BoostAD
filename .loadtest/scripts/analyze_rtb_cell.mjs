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
    stages: Object.fromEntries(
      [
        'match',
        'match_request_embedding',
        'match_ann_search',
        'match_ann_group_hits',
        'match_campaign_hydrate_redis',
        'match_campaign_hydrate_snapshot',
        'match_exact_rerank',
        'reserve',
        'rollback',
        'total',
      ].map((stage) => [
        stage,
        durationHistogramDelta(
          before,
          after,
          'boostad_rtb_stage_duration_seconds',
          { stage }
        ),
      ])
    ),
    fanout: {
      matchedCandidates: histogramDelta(
        before,
        after,
        'boostad_rtb_candidate_count'
      ),
      reserveAttempts: histogramDelta(
        before,
        after,
        'boostad_rtb_reserve_attempt_candidate_count'
      ),
      reservedCandidates: histogramDelta(
        before,
        after,
        'boostad_rtb_reserved_candidate_count'
      ),
      rollbackCandidates: histogramDelta(
        before,
        after,
        'boostad_rtb_rollback_candidate_count'
      ),
    },
    embedding: {
      l1Hit: counterDeltaByMetric(
        before,
        after,
        'boostad_rtb_embedding_l1_hit_total'
      ),
      l1Miss: counterDeltaByMetric(
        before,
        after,
        'boostad_rtb_embedding_l1_miss_total'
      ),
      l1Eviction: counterDeltaByMetric(
        before,
        after,
        'boostad_rtb_embedding_l1_eviction_total'
      ),
      l2Hit: counterDeltaByMetric(
        before,
        after,
        'boostad_rtb_embedding_l2_hit_total'
      ),
      l2Miss: counterDeltaByMetric(
        before,
        after,
        'boostad_rtb_embedding_l2_miss_total'
      ),
      l2Timeout: counterDeltaByMetric(
        before,
        after,
        'boostad_rtb_embedding_l2_timeout_total'
      ),
      l2WriteTimeout: counterDeltaByMetric(
        before,
        after,
        'boostad_rtb_embedding_l2_write_timeout_total'
      ),
      l2Error: counterDeltaByMetric(
        before,
        after,
        'boostad_rtb_embedding_l2_error_total'
      ),
      singleflightWait: counterDeltaByMetric(
        before,
        after,
        'boostad_rtb_embedding_singleflight_wait_total'
      ),
      singleflightDuration: histogramDelta(
        before,
        after,
        'boostad_rtb_embedding_singleflight_duration_seconds'
      ),
      runtime: counterDeltaByMetric(
        before,
        after,
        'boostad_rtb_embedding_runtime_total'
      ),
      source: {
        'tag-L1': counterDeltaByLabel(
          before,
          after,
          'boostad_rtb_embedding_source_total',
          'source',
          'tag-L1'
        ),
        'tag-L2': counterDeltaByLabel(
          before,
          after,
          'boostad_rtb_embedding_source_total',
          'source',
          'tag-L2'
        ),
        runtime: counterDeltaByLabel(
          before,
          after,
          'boostad_rtb_embedding_source_total',
          'source',
          'runtime'
        ),
        fallback: counterDeltaByLabel(
          before,
          after,
          'boostad_rtb_embedding_source_total',
          'source',
          'fallback'
        ),
        context: counterDeltaByLabel(
          before,
          after,
          'boostad_rtb_embedding_source_total',
          'source',
          'context'
        ),
      },
      background: {
        scheduled: counterDeltaByLabel(
          before,
          after,
          'boostad_rtb_embedding_background_total',
          'result',
          'scheduled'
        ),
        deduplicated: counterDeltaByLabel(
          before,
          after,
          'boostad_rtb_embedding_background_total',
          'result',
          'deduplicated'
        ),
        completed: counterDeltaByLabel(
          before,
          after,
          'boostad_rtb_embedding_background_total',
          'result',
          'completed'
        ),
        failed: counterDeltaByLabel(
          before,
          after,
          'boostad_rtb_embedding_background_total',
          'result',
          'failed'
        ),
        dropped: counterDeltaByLabel(
          before,
          after,
          'boostad_rtb_embedding_background_total',
          'result',
          'dropped'
        ),
      },
      lexicalFallback: {
        total: counterDeltaByMetric(
          before,
          after,
          'boostad_rtb_lexical_fallback_total'
        ),
        candidates: histogramDelta(
          before,
          after,
          'boostad_rtb_lexical_candidate_count'
        ),
      },
      context: {
        observe: {
          ready: counterDeltaByLabel(
            before,
            after,
            'boostad_rtb_context_observe_total',
            'status',
            'READY'
          ),
          pending: counterDeltaByLabel(
            before,
            after,
            'boostad_rtb_context_observe_total',
            'status',
            'PENDING'
          ),
          failed: counterDeltaByLabel(
            before,
            after,
            'boostad_rtb_context_observe_total',
            'status',
            'FAILED'
          ),
        },
        jobs: {
          enqueued: counterDeltaByLabel(
            before,
            after,
            'boostad_rtb_context_job_total',
            'result',
            'enqueued'
          ),
          deduplicated: counterDeltaByLabel(
            before,
            after,
            'boostad_rtb_context_job_total',
            'result',
            'deduplicated'
          ),
          completed: counterDeltaByLabel(
            before,
            after,
            'boostad_rtb_context_job_total',
            'result',
            'completed'
          ),
          failed: counterDeltaByLabel(
            before,
            after,
            'boostad_rtb_context_job_total',
            'result',
            'failed'
          ),
        },
        generation: histogramDelta(
          before,
          after,
          'boostad_rtb_context_embedding_duration_seconds'
        ),
        decision: Object.fromEntries(
          ['READY', 'PENDING', 'FAILED', 'MISS', 'TIMEOUT', 'ERROR'].map(
            (status) => [
              status,
              counterDeltaByLabel(
                before,
                after,
                'boostad_rtb_context_decision_total',
                'status',
                status
              ),
            ]
          )
        ),
      },
    },
    cpuSeconds: counterDeltaByMetric(
      before,
      after,
      'boostad_backend_process_cpu_seconds_total'
    ),
  },
  labels: {
    budgetPressureObserved: reservationRejected > 0,
    budgetState:
      reservationRejected > 0
        ? 'PRESSURE_OBSERVED_DURING_CELL'
        : 'NO_REJECTION_OBSERVED',
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

function histogramDelta(beforeSamples, afterSamples, metric, labels = {}) {
  const sum = counterDelta(beforeSamples, afterSamples, `${metric}_sum`, labels);
  const count = counterDelta(
    beforeSamples,
    afterSamples,
    `${metric}_count`,
    labels
  );
  return {
    count,
    sum,
    avg: count > 0 ? sum / count : null,
  };
}

function durationHistogramDelta(
  beforeSamples,
  afterSamples,
  metric,
  labels = {}
) {
  const delta = histogramDelta(beforeSamples, afterSamples, metric, labels);
  return {
    count: delta.count,
    sumSeconds: delta.sum,
    avgMs: delta.avg === null ? null : delta.avg * 1000,
    p50UpperBoundMs: histogramQuantileUpperBoundMs(
      beforeSamples,
      afterSamples,
      metric,
      labels,
      0.5
    ),
    p95UpperBoundMs: histogramQuantileUpperBoundMs(
      beforeSamples,
      afterSamples,
      metric,
      labels,
      0.95
    ),
    p99UpperBoundMs: histogramQuantileUpperBoundMs(
      beforeSamples,
      afterSamples,
      metric,
      labels,
      0.99
    ),
  };
}

function histogramQuantileUpperBoundMs(
  beforeSamples,
  afterSamples,
  metric,
  labels,
  quantile
) {
  const count = counterDelta(
    beforeSamples,
    afterSamples,
    `${metric}_count`,
    labels
  );
  if (count === 0) {
    return null;
  }

  const boundaries = [
    ...new Set(
      afterSamples
        .filter(
          (sample) =>
            sample.metric === `${metric}_bucket` &&
            Object.entries(labels).every(
              ([key, value]) => sample.labels[key] === value
            )
        )
        .map((sample) => sample.labels.le)
    ),
  ].sort((a, b) => {
    if (a === '+Inf') return 1;
    if (b === '+Inf') return -1;
    return Number(a) - Number(b);
  });
  const target = count * quantile;

  for (const boundary of boundaries) {
    const cumulative = counterDelta(
      beforeSamples,
      afterSamples,
      `${metric}_bucket`,
      { ...labels, le: boundary }
    );
    if (cumulative >= target) {
      return boundary === '+Inf' ? null : Number(boundary) * 1000;
    }
  }

  return null;
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
