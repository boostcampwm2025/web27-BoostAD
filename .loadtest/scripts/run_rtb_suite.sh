#!/usr/bin/env bash

set -uo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
loadtest_dir="$(cd "${script_dir}/.." && pwd)"
repo_root="$(cd "${loadtest_dir}/.." && pwd)"

base_url="${BASE_URL:-http://127.0.0.1:3000}"
run_id="${RUN_ID:-$(date +%Y%m%d-%H%M%S)}"
variant="${VARIANT_LABEL:-current}"
duration="${DURATION:-60s}"
matrix="${MATRIX:-fixed:30 fixed:60 random:30 random:60}"
output_root="${OUTPUT_DIR:-${loadtest_dir}/results/${run_id}}"
corpus_path="${loadtest_dir}/k6/data/rtb-random-corpus.json"
corpus_size="${RTB_CORPUS_SIZE:-3600}"
corpus_seed="${RTB_CORPUS_SEED:-20260710}"

require_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    printf 'required command not found: %s\n' "$1" >&2
    exit 1
  fi
}

for command in curl jq node k6 git shasum; do
  require_cmd "$command"
done

mkdir -p "$output_root"

(
  cd "$loadtest_dir"
  RTB_CORPUS_SIZE="$corpus_size" \
  RTB_CORPUS_SEED="$corpus_seed" \
    node scripts/generate_rtb_corpus.mjs "$corpus_path"
) >"${output_root}/corpus-generation.json"

corpus_sha="$(shasum -a 256 "$corpus_path" | awk '{print $1}')"
git_sha="$(git -C "$repo_root" rev-parse HEAD)"
git_diff_sha="$(git -C "$repo_root" diff --binary | shasum -a 256 | awk '{print $1}')"

jq -n \
  --arg runId "$run_id" \
  --arg variant "$variant" \
  --arg duration "$duration" \
  --arg matrix "$matrix" \
  --arg gitSha "$git_sha" \
  --arg gitDiffSha "$git_diff_sha" \
  --arg corpusSha "$corpus_sha" \
  --arg corpusSeed "$corpus_seed" \
  --arg budgetMode "${RTB_BUDGET_MODE:-winner_only}" \
  --argjson corpusSize "$corpus_size" \
  '{
    runId: $runId,
    variant: $variant,
    evidence: "PROVISIONAL",
    duration: $duration,
    matrix: $matrix,
    gitSha: $gitSha,
    gitDiffSha: $gitDiffSha,
    budgetMode: $budgetMode,
    corpus: {sha256: $corpusSha, seed: $corpusSeed, size: $corpusSize},
    lifecycle: {
      restartBackendEachCell: false,
      isolation: "reset-api",
      warmupOutsideCorpus: true,
      resetAfterWarmup: true
    }
  }' >"${output_root}/manifest.json"

suite_failed=0
sampler_pid=""

cleanup_sampler() {
  if [ -n "$sampler_pid" ]; then
    kill "$sampler_pid" >/dev/null 2>&1 || true
    for _ in $(seq 1 10); do
      if ! kill -0 "$sampler_pid" >/dev/null 2>&1; then
        break
      fi
      sleep 0.2
    done
    if kill -0 "$sampler_pid" >/dev/null 2>&1; then
      kill -9 "$sampler_pid" >/dev/null 2>&1 || true
    fi
    wait "$sampler_pid" >/dev/null 2>&1 || true
    sampler_pid=""
  fi
}

trap cleanup_sampler EXIT INT TERM

reset_cell_state() {
  local output="$1"
  (
    cd "$loadtest_dir"
    RESET_ONLY=true \
    RESET_OUTPUT="$output" \
    EXPECTED_CAMPAIGN_COUNT="${EXPECTED_CAMPAIGN_COUNT:-1000}" \
    LOADTEST_RESET_TOKEN="${LOADTEST_RESET_TOKEN:-}" \
    RESET_BASE_URL="${RESET_BASE_URL:-$base_url}" \
      scripts/reset_and_run_k6.sh local
  )
}

warm_backend() {
  local output="$1"
  for _ in $(seq 1 60); do
    if curl --fail --silent --show-error \
      -X POST "${base_url}/api/sdk/decision" \
      -H 'Content-Type: application/json' \
      --data '{"blogKey":"test-blog","postUrl":"http://127.0.0.1/posts/loadtest-warmup","tags":["typescript","react","nestjs"],"behaviorScore":50,"isHighIntent":false}' \
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

reservation_rejected_total() {
  local metrics_file="$1"
  awk '
    $1 ~ /^boostad_rtb_reservation_failures_total\{/ && $1 ~ /reason="rejected"/ {
      sum += $2
    }
    END { printf "%.0f\n", sum + 0 }
  ' "$metrics_file"
}

sample_budget_pressure() {
  local metrics_url="$1/api/metrics"
  local baseline_file="$2"
  local timeseries_file="$3"
  local onset_file="$4"
  local baseline
  local current
  local elapsed_ms
  local started_ms
  local tmp

  trap 'if [ -n "${tmp:-}" ]; then rm -f "$tmp"; fi' EXIT INT TERM

  baseline="$(reservation_rejected_total "$baseline_file")"
  started_ms="$(node -e 'process.stdout.write(String(Date.now()))')"
  : >"$timeseries_file"
  jq -n \
    --argjson baseline "$baseline" \
    '{observed:false,baselineRejected:$baseline,onsetElapsedMs:null,onsetAbsoluteMs:null,firstRejectedTotal:null}' \
    >"$onset_file"

  while true; do
    tmp="$(mktemp)"
    if curl --fail --silent --show-error "$metrics_url" >"$tmp"; then
      current="$(reservation_rejected_total "$tmp")"
      elapsed_ms="$(node -e "process.stdout.write(String(Date.now() - ${started_ms}))")"
      jq -nc \
        --argjson t "$elapsed_ms" \
        --argjson rejected "$current" \
        --argjson delta "$((current - baseline))" \
        '{elapsedMs:$t,reservationRejectedTotal:$rejected,deltaFromBaseline:$delta}' \
        >>"$timeseries_file"

      if [ "$((current - baseline))" -gt 0 ] && \
        jq -e '.observed == false' "$onset_file" >/dev/null; then
        jq -n \
          --argjson baseline "$baseline" \
          --argjson rejected "$current" \
          --argjson elapsed "$elapsed_ms" \
          --argjson absolute "$(node -e 'process.stdout.write(String(Date.now()))')" \
          '{
            observed:true,
            baselineRejected:$baseline,
            firstRejectedTotal:$rejected,
            onsetElapsedMs:$elapsed,
            onsetAbsoluteMs:$absolute
          }' >"$onset_file"
      fi
    fi
    rm -f "$tmp"
    sleep 1
  done
}

for cell in $matrix; do
  scenario="${cell%%:*}"
  rate="${cell##*:}"
  tag="${variant}_${scenario}_r${rate}"
  cell_dir="${output_root}/${tag}"
  mkdir -p "$cell_dir"

  if [ "$scenario" = "fixed" ]; then
    k6_script="k6/http/rtb-decision.js"
  elif [ "$scenario" = "random" ]; then
    k6_script="k6/http/rtb-decision-random-pool.js"
  else
    printf 'unsupported scenario in MATRIX: %s\n' "$scenario" >&2
    suite_failed=1
    continue
  fi

  printf '[suite] start %s\n' "$tag"

  reset_cell_state "${cell_dir}/reset_initial_response.json"
  reset_rc=$?
  if [ "$reset_rc" -ne 0 ]; then
    printf '%s\n' "$reset_rc" >"${cell_dir}/reset_exit_code.txt"
    suite_failed=1
    continue
  fi

  warm_backend "${cell_dir}/warmup_response.json"
  warmup_rc=$?
  if [ "$warmup_rc" -ne 0 ]; then
    printf '%s\n' "$warmup_rc" >"${cell_dir}/warmup_exit_code.txt"
    suite_failed=1
    continue
  fi

  reset_cell_state "${cell_dir}/reset_response.json"
  reset_rc=$?
  if [ "$reset_rc" -ne 0 ]; then
    printf '%s\n' "$reset_rc" >"${cell_dir}/reset_after_warmup_exit_code.txt"
    suite_failed=1
    continue
  fi

  curl --fail --silent --show-error "${base_url}/api/metrics" \
    >"${cell_dir}/metrics_before.txt"

  sample_budget_pressure \
    "${base_url}" \
    "${cell_dir}/metrics_before.txt" \
    "${cell_dir}/metrics_timeseries.ndjson" \
    "${cell_dir}/budget_pressure_onset.json" &
  sampler_pid=$!

  (
    cd "$loadtest_dir"
    BASE_URL="$base_url" \
    SCENARIO=constant-arrival-rate \
    RATE="$rate" \
    DURATION="$duration" \
    SLEEP=0 \
    TIME_UNIT=1s \
    PRE_ALLOCATED_VUS="${PRE_ALLOCATED_VUS:-50}" \
    MAX_VUS="${MAX_VUS:-240}" \
    BLOG_KEY="${BLOG_KEY:-test-blog}" \
    POST_URL="${POST_URL:-http://127.0.0.1/posts/1}" \
    TAGS="${TAGS:-typescript,react,nestjs}" \
    HIGH_INTENT="${HIGH_INTENT:-false}" \
    BEHAVIOR_SCORE="${BEHAVIOR_SCORE:-50}" \
      k6 run \
        --summary-export "${cell_dir}/k6_summary.json" \
        "$k6_script"
  ) 2>&1 | tee "${cell_dir}/k6_stdout.txt"
  k6_rc=${PIPESTATUS[0]}

  kill "$sampler_pid" >/dev/null 2>&1 || true
  # sampler is an infinite loop; force-stop if it ignores TERM
  for _ in $(seq 1 10); do
    if ! kill -0 "$sampler_pid" >/dev/null 2>&1; then
      break
    fi
    sleep 0.2
  done
  if kill -0 "$sampler_pid" >/dev/null 2>&1; then
    kill -9 "$sampler_pid" >/dev/null 2>&1 || true
  fi
  wait "$sampler_pid" >/dev/null 2>&1 || true
  sampler_pid=""

  printf '%s\n' "$k6_rc" >"${cell_dir}/k6_exit_code.txt"
  curl --fail --silent --show-error "${base_url}/api/metrics" \
    >"${cell_dir}/metrics_after.txt"

  if [ -f "${cell_dir}/k6_summary.json" ]; then
    node "${script_dir}/analyze_rtb_cell.mjs" \
      "${cell_dir}/k6_summary.json" \
      "${cell_dir}/metrics_before.txt" \
      "${cell_dir}/metrics_after.txt" \
      "${cell_dir}/analysis.json" \
      >"${cell_dir}/analysis.stdout.json"
  else
    suite_failed=1
  fi

  printf '[suite] done %s k6_exit=%s\n' "$tag" "$k6_rc"
done

exit "$suite_failed"
