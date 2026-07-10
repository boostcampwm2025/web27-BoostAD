#!/usr/bin/env bash

# Phase 3A target profiles (hot-tag / concurrent-same-tag / cross-instance).
# Does not relax run_rtb_suite.sh thresholds. Fixed/Random regression is optional.

set -uo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
loadtest_dir="$(cd "${script_dir}/.." && pwd)"
repo_root="$(cd "${loadtest_dir}/.." && pwd)"

base_url="${BASE_URL:-http://127.0.0.1:3000}"
base_url_b="${BASE_URL_B:-http://127.0.0.1:3001}"
run_id="${RUN_ID:-$(date +%Y%m%d-%H%M%S)-phase3a}"
variant="${VARIANT_LABEL:-phase3a}"
output_root="${OUTPUT_DIR:-${loadtest_dir}/results/${run_id}}"
profiles="${PROFILES:-hot-tag concurrent-same-tag}"
include_cross="${INCLUDE_CROSS_INSTANCE:-false}"
include_regression="${INCLUDE_REGRESSION_SMOKE:-false}"
cold_tag_suffix="${COLD_TAG_SUFFIX:-$(date +%s)}"

case " ${profiles} " in
  *" cross-instance "*) profiles_include_cross="true" ;;
  *) profiles_include_cross="false" ;;
esac

if [ "$include_cross" = "true" ] && [ "$profiles_include_cross" = "false" ]; then
  profiles="${profiles} cross-instance"
  profiles_include_cross="true"
fi

require_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    printf 'required command not found: %s\n' "$1" >&2
    exit 1
  fi
}

for command in curl jq node k6 git; do
  require_cmd "$command"
done

mkdir -p "$output_root"

git_sha="$(git -C "$repo_root" rev-parse HEAD)"
jq -n \
  --arg runId "$run_id" \
  --arg variant "$variant" \
  --arg profiles "$profiles" \
  --arg gitSha "$git_sha" \
  --arg budgetMode "${RTB_BUDGET_MODE:-winner_only}" \
  --arg campaignSource "${RTB_CAMPAIGN_SOURCE:-local_snapshot}" \
  --argjson includeCross "$profiles_include_cross" \
  --argjson includeRegression "$([ "$include_regression" = "true" ] && echo true || echo false)" \
  '{
    runId: $runId,
    variant: $variant,
    evidence: "PROVISIONAL",
    kind: "phase3a-target",
    profiles: $profiles,
    gitSha: $gitSha,
    budgetMode: $budgetMode,
    campaignSource: $campaignSource,
    includeCrossInstance: $includeCross,
    includeRegressionSmoke: $includeRegression
  }' >"${output_root}/manifest.json"

suite_failed=0

reset_cell_state() {
  local output="$1"
  local reset_base="${2:-$base_url}"
  (
    cd "$loadtest_dir"
    RESET_ONLY=true \
    RESET_OUTPUT="$output" \
    EXPECTED_CAMPAIGN_COUNT="${EXPECTED_CAMPAIGN_COUNT:-1000}" \
    LOADTEST_RESET_TOKEN="${LOADTEST_RESET_TOKEN:-}" \
    RESET_BASE_URL="$reset_base" \
      scripts/reset_and_run_k6.sh local
  )
}

warm_backend() {
  local url="$1"
  local output="$2"
  local tags_json="$3"
  for _ in $(seq 1 60); do
    if curl --fail --silent --show-error \
      -X POST "${url}/api/sdk/decision" \
      -H 'Content-Type: application/json' \
      --data "{\"blogKey\":\"test-blog\",\"postUrl\":\"http://127.0.0.1/posts/loadtest-warmup\",\"tags\":${tags_json},\"behaviorScore\":50,\"isHighIntent\":false}" \
      >"$output" && \
      jq -e \
        '.status == "success" and (.data.auctionId | type == "string") and (.data.campaign.id | type == "string")' \
        "$output" >/dev/null; then
      return 0
    fi
    sleep 1
  done
  return 1
}

metric_value() {
  local file="$1"
  local metric="$2"
  awk -v metric="$metric" '
    $1 == metric || index($1, metric "{") == 1 { sum += $2 }
    END { printf "%.0f\n", sum + 0 }
  ' "$file"
}

analyze_cell() {
  local cell_dir="$1"
  if [ -f "${cell_dir}/k6_summary.json" ]; then
    node "${script_dir}/analyze_rtb_cell.mjs" \
      "${cell_dir}/k6_summary.json" \
      "${cell_dir}/metrics_before.txt" \
      "${cell_dir}/metrics_after.txt" \
      "${cell_dir}/analysis.json" \
      >"${cell_dir}/analysis.stdout.json"
  else
    return 1
  fi
}

run_hot_tag() {
  local cell_dir="${output_root}/hot-tag"
  mkdir -p "$cell_dir"
  printf '[phase3a] start hot-tag\n'

  reset_cell_state "${cell_dir}/reset_initial_response.json" || return 1
  warm_backend "$base_url" "${cell_dir}/warmup_response.json" '["typescript","react","nestjs"]' || return 1
  reset_cell_state "${cell_dir}/reset_response.json" || return 1

  # seed L1/L2 once, then measure hot path
  warm_backend "$base_url" "${cell_dir}/seed_response.json" '["typescript","react","nestjs"]' || return 1

  curl --fail --silent --show-error "${base_url}/api/metrics" \
    >"${cell_dir}/metrics_before.txt"

  (
    cd "$loadtest_dir"
    BASE_URL="$base_url" \
    SCENARIO=constant-arrival-rate \
    RATE="${HOT_TAG_RATE:-20}" \
    DURATION="${HOT_TAG_DURATION:-30s}" \
    SLEEP=0 \
    TIME_UNIT=1s \
    PRE_ALLOCATED_VUS="${PRE_ALLOCATED_VUS:-20}" \
    MAX_VUS="${MAX_VUS:-80}" \
    BLOG_KEY="${BLOG_KEY:-test-blog}" \
    POST_URL="${POST_URL:-http://127.0.0.1/posts/phase3a-hot}" \
    TAGS="${TAGS:-typescript,react,nestjs}" \
    HIGH_INTENT="${HIGH_INTENT:-false}" \
    BEHAVIOR_SCORE="${BEHAVIOR_SCORE:-50}" \
      k6 run \
        --summary-export "${cell_dir}/k6_summary.json" \
        k6/http/rtb-decision.js
  ) 2>&1 | tee "${cell_dir}/k6_stdout.txt"
  local k6_rc=${PIPESTATUS[0]}
  printf '%s\n' "$k6_rc" >"${cell_dir}/k6_exit_code.txt"

  curl --fail --silent --show-error "${base_url}/api/metrics" \
    >"${cell_dir}/metrics_after.txt"
  analyze_cell "$cell_dir" || return 1

  local runtime l1_hit
  runtime="$(metric_value "${cell_dir}/metrics_after.txt" 'boostad_rtb_embedding_runtime_total')"
  local runtime_before
  runtime_before="$(metric_value "${cell_dir}/metrics_before.txt" 'boostad_rtb_embedding_runtime_total')"
  l1_hit="$(jq -r '.server.embedding.l1Hit // 0' "${cell_dir}/analysis.json")"
  local runtime_delta=$((runtime - runtime_before))

  jq -n \
    --argjson runtimeDelta "$runtime_delta" \
    --argjson l1Hit "$l1_hit" \
    --argjson pass "$([ "$runtime_delta" -le 1 ] && [ "$l1_hit" -gt 0 ] && echo true || echo false)" \
    '{
      profile: "hot-tag",
      runtimeDelta: $runtimeDelta,
      l1Hit: $l1Hit,
      pass: $pass,
      criteria: "warmup 이후 runtime≈0(<=1) AND l1Hit>0"
    }' >"${cell_dir}/verdict.json"

  jq -e '.pass == true' "${cell_dir}/verdict.json" >/dev/null
}

run_concurrent_same_tag() {
  local cell_dir="${output_root}/concurrent-same-tag"
  mkdir -p "$cell_dir"
  printf '[phase3a] start concurrent-same-tag\n'

  local tags="phase3a-cold-${cold_tag_suffix},nestjs,react"
  reset_cell_state "${cell_dir}/reset_initial_response.json" || return 1
  # warmup with different tags so ANN/model is ready without seeding the cold key
  warm_backend "$base_url" "${cell_dir}/warmup_response.json" '["typescript","react","nestjs"]' || return 1
  reset_cell_state "${cell_dir}/reset_response.json" || return 1

  curl --fail --silent --show-error "${base_url}/api/metrics" \
    >"${cell_dir}/metrics_before.txt"

  (
    cd "$loadtest_dir"
    BASE_URL="$base_url" \
    VUS="${CONCURRENT_VUS:-40}" \
    ITERATIONS="${CONCURRENT_ITERATIONS:-40}" \
    MAX_DURATION="${CONCURRENT_MAX_DURATION:-30s}" \
    SLEEP=0 \
    BLOG_KEY="${BLOG_KEY:-test-blog}" \
    POST_URL="${POST_URL:-http://127.0.0.1/posts/phase3a-concurrent}" \
    TAGS="$tags" \
    HIGH_INTENT="${HIGH_INTENT:-false}" \
    BEHAVIOR_SCORE="${BEHAVIOR_SCORE:-50}" \
      k6 run \
        --summary-export "${cell_dir}/k6_summary.json" \
        k6/http/rtb-decision-concurrent.js
  ) 2>&1 | tee "${cell_dir}/k6_stdout.txt"
  local k6_rc=${PIPESTATUS[0]}
  printf '%s\n' "$k6_rc" >"${cell_dir}/k6_exit_code.txt"

  curl --fail --silent --show-error "${base_url}/api/metrics" \
    >"${cell_dir}/metrics_after.txt"
  analyze_cell "$cell_dir" || return 1

  local runtime_delta wait_count
  runtime_delta="$(jq -r '.server.embedding.runtime // 0' "${cell_dir}/analysis.json")"
  wait_count="$(jq -r '.server.embedding.singleflightWait // 0' "${cell_dir}/analysis.json")"

  jq -n \
    --argjson runtimeDelta "$runtime_delta" \
    --argjson singleflightWait "$wait_count" \
    --arg tags "$tags" \
    --argjson pass "$([ "$runtime_delta" -le 2 ] && [ "$wait_count" -gt 0 ] && echo true || echo false)" \
    '{
      profile: "concurrent-same-tag",
      tags: $tags,
      runtimeDelta: $runtimeDelta,
      singleflightWait: $singleflightWait,
      pass: $pass,
      criteria: "cold burst에서 runtime<=2 AND singleflightWait>0"
    }' >"${cell_dir}/verdict.json"

  jq -e '.pass == true' "${cell_dir}/verdict.json" >/dev/null
}

run_cross_instance() {
  local cell_dir="${output_root}/cross-instance"
  mkdir -p "$cell_dir"
  printf '[phase3a] start cross-instance\n'

  local tags_json="[\"phase3a-cross-${cold_tag_suffix}\",\"nestjs\"]"
  local tags="phase3a-cross-${cold_tag_suffix},nestjs"

  if ! curl --fail --silent --show-error "${base_url_b}/api/metrics" \
    >"${cell_dir}/metrics_b_probe.txt"; then
    jq -n '{profile:"cross-instance",pass:false,valid:false,reason:"backend-b unreachable"}' \
      >"${cell_dir}/verdict.json"
    return 1
  fi

  reset_cell_state "${cell_dir}/reset_a.json" "$base_url" || return 1
  warm_backend "$base_url" "${cell_dir}/warmup_a.json" '["typescript","react","nestjs"]' || return 1
  warm_backend "$base_url_b" "${cell_dir}/warmup_b.json" '["typescript","react","nestjs"]' || return 1

  curl --fail --silent --show-error "${base_url}/api/metrics" \
    >"${cell_dir}/metrics_a_before.txt"
  curl --fail --silent --show-error "${base_url_b}/api/metrics" \
    >"${cell_dir}/metrics_b_before.txt"

  # A cold miss -> L2 write
  curl --fail --silent --show-error \
    -X POST "${base_url}/api/sdk/decision" \
    -H 'Content-Type: application/json' \
    --data "{\"blogKey\":\"test-blog\",\"postUrl\":\"http://127.0.0.1/posts/phase3a-cross-a\",\"tags\":${tags_json},\"behaviorScore\":50,\"isHighIntent\":false}" \
    >"${cell_dir}/decision_a.json" || return 1

  curl --fail --silent --show-error "${base_url}/api/metrics" \
    >"${cell_dir}/metrics_a_after_write.txt"

  # B should L2 hit (empty L1)
  curl --fail --silent --show-error \
    -X POST "${base_url_b}/api/sdk/decision" \
    -H 'Content-Type: application/json' \
    --data "{\"blogKey\":\"test-blog\",\"postUrl\":\"http://127.0.0.1/posts/phase3a-cross-b\",\"tags\":${tags_json},\"behaviorScore\":50,\"isHighIntent\":false}" \
    >"${cell_dir}/decision_b.json" || return 1

  curl --fail --silent --show-error "${base_url_b}/api/metrics" \
    >"${cell_dir}/metrics_b_after.txt"

  local a_runtime_before a_runtime_after b_l2_before b_l2_after b_runtime_before b_runtime_after
  a_runtime_before="$(metric_value "${cell_dir}/metrics_a_before.txt" 'boostad_rtb_embedding_runtime_total')"
  a_runtime_after="$(metric_value "${cell_dir}/metrics_a_after_write.txt" 'boostad_rtb_embedding_runtime_total')"
  b_l2_before="$(metric_value "${cell_dir}/metrics_b_before.txt" 'boostad_rtb_embedding_l2_hit_total')"
  b_l2_after="$(metric_value "${cell_dir}/metrics_b_after.txt" 'boostad_rtb_embedding_l2_hit_total')"
  b_runtime_before="$(metric_value "${cell_dir}/metrics_b_before.txt" 'boostad_rtb_embedding_runtime_total')"
  b_runtime_after="$(metric_value "${cell_dir}/metrics_b_after.txt" 'boostad_rtb_embedding_runtime_total')"

  local a_runtime_delta=$((a_runtime_after - a_runtime_before))
  local b_l2_delta=$((b_l2_after - b_l2_before))
  local b_runtime_delta=$((b_runtime_after - b_runtime_before))

  jq -n \
    --arg tags "$tags" \
    --argjson aRuntimeDelta "$a_runtime_delta" \
    --argjson bL2HitDelta "$b_l2_delta" \
    --argjson bRuntimeDelta "$b_runtime_delta" \
    --argjson pass "$([ "$a_runtime_delta" -ge 1 ] && [ "$b_l2_delta" -ge 1 ] && [ "$b_runtime_delta" -eq 0 ] && echo true || echo false)" \
    '{
      profile: "cross-instance",
      valid: true,
      tags: $tags,
      aRuntimeDelta: $aRuntimeDelta,
      bL2HitDelta: $bL2HitDelta,
      bRuntimeDelta: $bRuntimeDelta,
      pass: $pass,
      criteria: "A runtime>=1 AND B l2Hit>=1 AND B runtime==0"
    }' >"${cell_dir}/verdict.json"

  # minimal analysis stub for consistency
  jq -n \
    --argjson aRuntimeDelta "$a_runtime_delta" \
    --argjson bL2HitDelta "$b_l2_delta" \
    --argjson bRuntimeDelta "$b_runtime_delta" \
    '{
      k6: null,
      server: {
        embedding: {
          aRuntimeDelta: $aRuntimeDelta,
          bL2HitDelta: $bL2HitDelta,
          bRuntimeDelta: $bRuntimeDelta
        }
      },
      labels: { evidence: "PROVISIONAL", kind: "cross-instance" }
    }' >"${cell_dir}/analysis.json"

  jq -e '.pass == true' "${cell_dir}/verdict.json" >/dev/null
}

run_regression_smoke() {
  local cell_dir="${output_root}/regression-smoke"
  mkdir -p "$cell_dir"
  printf '[phase3a] start REGRESSION_SMOKE Fixed/Random\n'

  RUN_ID="${run_id}-regression" \
  VARIANT_LABEL="${variant}_REGRESSION_SMOKE" \
  DURATION="${REGRESSION_DURATION:-60s}" \
  MATRIX="${REGRESSION_MATRIX:-fixed:30 fixed:60 random:30 random:60}" \
  BASE_URL="$base_url" \
  OUTPUT_DIR="$cell_dir" \
  RTB_CAMPAIGN_SOURCE="${RTB_CAMPAIGN_SOURCE:-local_snapshot}" \
  RTB_BUDGET_MODE="${RTB_BUDGET_MODE:-winner_only}" \
    "${script_dir}/run_rtb_suite.sh"

  jq -n '{
    profile: "REGRESSION_SMOKE",
    pass: null,
    note: "Phase 3A DoD에 포함하지 않음. 기능 회귀·대폭 악화 여부만 확인."
  }' >"${cell_dir}/verdict.json"
}

for profile in $profiles; do
  case "$profile" in
    hot-tag)
      if ! run_hot_tag; then
        suite_failed=1
        printf '[phase3a] FAIL hot-tag\n'
      else
        printf '[phase3a] PASS hot-tag\n'
      fi
      ;;
    concurrent-same-tag)
      if ! run_concurrent_same_tag; then
        suite_failed=1
        printf '[phase3a] FAIL concurrent-same-tag\n'
      else
        printf '[phase3a] PASS concurrent-same-tag\n'
      fi
      ;;
    cross-instance)
      if ! run_cross_instance; then
        suite_failed=1
        printf '[phase3a] FAIL cross-instance\n'
      else
        printf '[phase3a] PASS cross-instance\n'
      fi
      ;;
    *)
      printf 'unknown profile: %s\n' "$profile" >&2
      suite_failed=1
      ;;
  esac
done

if [ "$include_regression" = "true" ]; then
  if ! run_regression_smoke; then
    suite_failed=1
    printf '[phase3a] REGRESSION_SMOKE finished with errors (not DoD)\n'
  else
    printf '[phase3a] REGRESSION_SMOKE finished\n'
  fi
fi

jq -n \
  --argjson failed "$suite_failed" \
  '{productPass: ($failed == 0), suiteFailed: $failed}' \
  >"${output_root}/suite_verdict.json"

exit "$suite_failed"
