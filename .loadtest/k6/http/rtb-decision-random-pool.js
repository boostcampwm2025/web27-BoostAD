import http from 'k6/http';
import exec from 'k6/execution';
import { check, sleep } from 'k6';
import { SharedArray } from 'k6/data';
import { Counter, Rate, Trend } from 'k6/metrics';

import { env, envBool, envFloat, envInt } from '../lib/env.js';
import { classifyDecisionResponse } from '../lib/rtb-result.js';
import { resolveUrl } from '../lib/url.js';

const errors = new Rate('errors');
const transportErrors = new Rate('transport_errors');
const businessErrors = new Rate('business_errors');
const businessSuccess = new Rate('business_success');
const businessErrorReasons = new Counter('business_error_reasons');
const decisionSuccessDuration = new Trend(
  'decision_success_duration',
  true
);

const baseUrl = env('BASE_URL', 'http://localhost:3000');
const decisionUrl = resolveUrl(baseUrl, '/api/sdk/decision');
const corpus = new SharedArray('rtb-deterministic-random-corpus', () => {
  const parsed = JSON.parse(open('../data/rtb-random-corpus.json'));
  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new Error('RTB random corpus must be a non-empty JSON array');
  }
  return parsed;
});

function buildOptions() {
  const scenario = env('SCENARIO', 'constant-vus');
  const insecureSkipTlsVerify = envBool('INSECURE_SKIP_TLS_VERIFY', false);
  const thresholds = {
    http_req_failed: ['rate<0.01'],
    http_req_duration: ['p(95)<300'],
    errors: ['rate<0.01'],
    business_errors: ['rate<0.01'],
  };
  const summaryTrendStats = [
    'avg',
    'min',
    'med',
    'p(90)',
    'p(95)',
    'p(99)',
    'max',
  ];

  if (scenario === 'constant-arrival-rate') {
    return {
      insecureSkipTLSVerify: insecureSkipTlsVerify,
      thresholds,
      summaryTrendStats,
      scenarios: {
        rtb_decision: {
          executor: 'constant-arrival-rate',
          rate: envInt('RATE', 50),
          timeUnit: env('TIME_UNIT', '1s'),
          duration: env('DURATION', '30s'),
          preAllocatedVUs: envInt('PRE_ALLOCATED_VUS', 50),
          maxVUs: envInt('MAX_VUS', 200),
        },
      },
    };
  }

  return {
    insecureSkipTLSVerify: insecureSkipTlsVerify,
    thresholds,
    summaryTrendStats,
    vus: envInt('VUS', 10),
    duration: env('DURATION', '30s'),
  };
}

export const options = buildOptions();

export default function () {
  const corpusIndex = exec.scenario.iterationInTest % corpus.length;
  const payload = JSON.stringify(corpus[corpusIndex]);
  const res = http.post(decisionUrl, payload, {
    headers: { 'Content-Type': 'application/json' },
  });

  const result = classifyDecisionResponse(res);
  check(res, {
    'decision: status is 2xx': (response) =>
      response.status >= 200 && response.status < 300,
    'decision: business success': () => result.businessOk,
  });

  transportErrors.add(!result.transportOk);
  businessErrors.add(!result.businessOk);
  businessSuccess.add(result.businessOk);
  errors.add(!result.businessOk);

  if (result.businessOk) {
    decisionSuccessDuration.add(res.timings.duration);
  } else {
    businessErrorReasons.add(1, { reason: result.reason });
  }

  sleep(envFloat('SLEEP', 0.1));
}
