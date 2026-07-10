#!/usr/bin/env bash
# Shared helpers for RTB loadtest harness (sourced by suite/profile scripts).

parse_duration_sec() {
  local raw="${1:-60s}"
  case "$raw" in
    *ms)
      awk -v v="${raw%ms}" 'BEGIN { printf "%.3f\n", v / 1000 }'
      ;;
    *s)
      printf '%s\n' "${raw%s}"
      ;;
    *m)
      awk -v v="${raw%m}" 'BEGIN { printf "%.0f\n", v * 60 }'
      ;;
    *h)
      awk -v v="${raw%h}" 'BEGIN { printf "%.0f\n", v * 3600 }'
      ;;
    *)
      printf '%s\n' "$raw"
      ;;
  esac
}

redis_cli() {
  docker exec boostad-redis-master-local redis-cli "$@"
}

embedding_queue_name() {
  if [ -n "${RTB_EMBEDDING_QUEUE_NAME:-}" ]; then
    printf '%s\n' "$RTB_EMBEDDING_QUEUE_NAME"
  elif [ "${RTB_EMBEDDING_PROFILE:-legacy_minilm}" = "legacy_minilm" ]; then
    printf '%s\n' 'embedding-queue'
  else
    printf 'embedding-queue-%s\n' "$RTB_EMBEDDING_PROFILE"
  fi
}

embedding_queue_key() {
  local state="$1"
  printf 'bull:%s:%s\n' "$(embedding_queue_name)" "$state"
}

embedding_queue_counts() {
  local wait active delayed
  wait="$(redis_cli LLEN "$(embedding_queue_key wait)" 2>/dev/null || echo 0)"
  active="$(redis_cli LLEN "$(embedding_queue_key active)" 2>/dev/null || echo 0)"
  delayed="$(redis_cli ZCARD "$(embedding_queue_key delayed)" 2>/dev/null || echo 0)"
  printf '%s %s %s\n' "${wait:-0}" "${active:-0}" "${delayed:-0}"
}

assert_embedding_queue_empty() {
  local label="${1:-preflight}"
  local wait active delayed
  read -r wait active delayed <<<"$(embedding_queue_counts)"
  if [ "${wait:-0}" -ne 0 ] || [ "${active:-0}" -ne 0 ] || [ "${delayed:-0}" -ne 0 ]; then
    printf '[harness] embedding queue not empty (%s): wait=%s active=%s delayed=%s\n' \
      "$label" "$wait" "$active" "$delayed" >&2
    return 1
  fi
  printf '[harness] embedding queue empty (%s)\n' "$label"
}

# Opt-in stable budget: mutate only members of campaign:keys (never SCAN campaign:*).
# Sets daily/total budget to 2e9 and spent to 0. Asserts modified == EXPECTED_CAMPAIGN_COUNT.
apply_stable_budget() {
  local expected="${EXPECTED_CAMPAIGN_COUNT:-1000}"
  local redis_container="${REDIS_CONTAINER:-boostad-redis-master-local}"
  local modified
  local lua

  lua='
local keys = redis.call("SMEMBERS", KEYS[1])
local n = 0
for _, key in ipairs(keys) do
  if string.sub(key, 1, 9) == "campaign:" then
    redis.call("JSON.SET", key, "$.dailyBudget", "2000000000")
    redis.call("JSON.SET", key, "$.totalBudget", "2000000000")
    redis.call("JSON.SET", key, "$.dailySpent", "0")
    redis.call("JSON.SET", key, "$.totalSpent", "0")
    n = n + 1
  end
end
return n
'

  modified="$(
    docker exec "$redis_container" redis-cli EVAL "$lua" 1 campaign:keys
  )"
  modified="$(printf '%s' "$modified" | tr -d '[:space:]')"
  if [ -z "$modified" ] || [ "$modified" = "(nil)" ]; then
    modified=0
  fi

  if [ "$modified" -ne "$expected" ]; then
    printf '[harness] STABLE_BUDGET assert failed: modified=%s expected=%s\n' \
      "$modified" "$expected" >&2
    return 1
  fi

  printf '[harness] STABLE_BUDGET applied: modified=%s daily/totalBudget=2000000000 spent=0\n' \
    "$modified"
}

write_cell_summary() {
  local analysis_json="$1"
  local onset_json="${2:-}"
  local out_json="$3"
  local scenario_duration_sec="${4:-0}"
  local rate_target="${5:-0}"
  local stable_budget="${6:-false}"

  node -e '
const fs = require("fs");
const analysis = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
const onsetPath = process.argv[2];
const outPath = process.argv[3];
const durationSec = Number(process.argv[4] || 0);
const rateTarget = Number(process.argv[5] || 0);
const stableBudget = process.argv[6] === "true";
let onset = null;
if (onsetPath && onsetPath !== "-" && fs.existsSync(onsetPath)) {
  onset = JSON.parse(fs.readFileSync(onsetPath, "utf8"));
}
const iterations = analysis?.k6?.iterations ?? 0;
const successOnly = analysis?.k6?.successOnly ?? null;
const rejectDelta = analysis?.server?.reservationRejected ?? 0;
const completedRps =
  durationSec > 0 ? iterations / durationSec : analysis?.k6?.completedRps ?? null;
const budgetInvalid = stableBudget && rejectDelta >= 1;
const summary = {
  rateTarget,
  scenarioDurationSec: durationSec || analysis?.k6?.scenarioDurationSec || null,
  iterations,
  completedRps,
  droppedIterations: analysis?.k6?.droppedIterations ?? 0,
  businessSuccessRate: analysis?.k6?.businessSuccessRate ?? null,
  transportErrorRate: analysis?.k6?.transportErrorRate ?? null,
  p50Ms: successOnly?.med ?? null,
  p95Ms: successOnly?.p95 ?? null,
  p99Ms: successOnly?.p99 ?? null,
  maxMs: successOnly?.max ?? null,
  reservationRejectedDelta: rejectDelta,
  budgetPressureObserved: Boolean(onset?.observed) || rejectDelta > 0,
  budgetPressureOnsetMs: onset?.onsetElapsedMs ?? null,
  validity: budgetInvalid ? "INVALID" : "VALID",
  invalidReason: budgetInvalid ? "budget_reject_delta_ge_1_under_STABLE_BUDGET" : null,
  evidence: "PROVISIONAL",
};
fs.writeFileSync(outPath, JSON.stringify(summary, null, 2) + "\n");
process.stdout.write(JSON.stringify(summary) + "\n");
' "$analysis_json" "${onset_json:--}" "$out_json" "$scenario_duration_sec" "$rate_target" "$stable_budget"
}

backend_image_id() {
  docker inspect boostad-backend-local --format '{{.Image}}' 2>/dev/null || echo "unknown"
}

backend_compose_image() {
  docker inspect boostad-backend-local --format '{{.Config.Image}}' 2>/dev/null || echo "unknown"
}

capture_backend_flags() {
  docker exec boostad-backend-local sh -c \
    'printf "RTB_MATCHER_ANN_ENABLED=%s\nRTB_CAMPAIGN_SOURCE=%s\nRTB_CONTEXT_DECISION_ENABLED=%s\nRTB_BUDGET_MODE=%s\nRTB_EMBEDDING_PROFILE=%s\nRTB_EMBEDDING_QUEUE_NAME=%s\nRTB_DENSE_RETRIEVAL_MODE=%s\nRTB_MATCHER_DOCUMENT_SIMILARITY_THRESHOLD=%s\n" \
      "${RTB_MATCHER_ANN_ENABLED:-}" "${RTB_CAMPAIGN_SOURCE:-}" \
      "${RTB_CONTEXT_DECISION_ENABLED:-}" "${RTB_BUDGET_MODE:-}" \
      "${RTB_EMBEDDING_PROFILE:-}" "${RTB_EMBEDDING_QUEUE_NAME:-}" \
      "${RTB_DENSE_RETRIEVAL_MODE:-}" \
      "${RTB_MATCHER_DOCUMENT_SIMILARITY_THRESHOLD:-}"' \
    2>/dev/null || true
}
