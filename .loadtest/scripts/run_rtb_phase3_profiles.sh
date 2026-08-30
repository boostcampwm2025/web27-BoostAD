#!/usr/bin/env bash
# Phase 3 content-target profiles (separate from phase3a tag profiles)
set -uo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
loadtest_dir="$(cd "${script_dir}/.." && pwd)"
repo_root="$(cd "${loadtest_dir}/.." && pwd)"

# shellcheck source=loadtest_common.sh
source "${script_dir}/loadtest_common.sh"

base_url="${BASE_URL:-http://127.0.0.1:3000}"
base_url_b="${BASE_URL_B:-http://127.0.0.1:3001}"
run_id="${RUN_ID:-$(date +%Y%m%d-%H%M%S)-phase3}"
output_root="${OUTPUT_DIR:-${loadtest_dir}/results/${run_id}}"
profiles="${PROFILES:-hot-content cold-content mixed-content concurrent-same-content second-visit multi-instance worker-down queue-pressure}"
duration="${DURATION:-60s}"
rate="${RATE:-30}"
pre_allocated_vus="${PRE_ALLOCATED_VUS:-40}"
max_vus="${MAX_VUS:-120}"
drain_timeout_secs="${DRAIN_TIMEOUT_SECS:-60}"
business_success_threshold="${BUSINESS_SUCCESS_THRESHOLD:-0.999}"
expected_embedding_replicas="${EXPECTED_EMBEDDING_WORKER_REPLICAS:-1}"
expected_reservation_replicas="${EXPECTED_RESERVATION_WORKER_REPLICAS:-1}"
k6_quiet="${K6_QUIET:-false}"
load_monitor_interval_secs="${LOAD_MONITOR_INTERVAL_SECS:-0}"
duration_sec="$(parse_duration_sec "$duration")"
suite_failed=0

mkdir -p "$output_root"
# The profile runner changes into .loadtest for reset/k6 execution. Resolve the
# artifact root once so every child process writes into the same run directory.
output_root="$(cd "$output_root" && pwd)"

git_sha="$(git -C "$repo_root" rev-parse HEAD 2>/dev/null || echo unknown)"
git_diff_sha="$(git -C "$repo_root" diff --binary 2>/dev/null | shasum -a 256 | awk '{print $1}')"
backend_image="$(backend_image_id)"
backend_compose="$(backend_compose_image)"
embedding_replicas="$(embedding_worker_replica_count)"
reservation_replicas="$(reservation_worker_replica_count)"
capture_backend_flags >"${output_root}/backend_env.txt" || true

ann_enabled="$(awk -F= '/^RTB_MATCHER_ANN_ENABLED=/{print $2}' "${output_root}/backend_env.txt" 2>/dev/null || true)"
campaign_source_flag="$(awk -F= '/^RTB_CAMPAIGN_SOURCE=/{print $2}' "${output_root}/backend_env.txt" 2>/dev/null || true)"
context_decision_flag="$(awk -F= '/^RTB_CONTEXT_DECISION_ENABLED=/{print $2}' "${output_root}/backend_env.txt" 2>/dev/null || true)"
budget_mode_flag="$(awk -F= '/^RTB_BUDGET_MODE=/{print $2}' "${output_root}/backend_env.txt" 2>/dev/null || true)"

# Optional corpus/dataset hash if present
dataset_hash="none"
if [ -f "${loadtest_dir}/k6/data/rtb-random-corpus.json" ]; then
  dataset_hash="$(shasum -a 256 "${loadtest_dir}/k6/data/rtb-random-corpus.json" | awk '{print $1}')"
fi

jq -n \
  --arg runId "$run_id" \
  --arg profiles "$profiles" \
  --arg gitSha "$git_sha" \
  --arg gitDiffSha "$git_diff_sha" \
  --argjson rate "$rate" \
  --arg duration "$duration" \
  --argjson durationSec "$duration_sec" \
  --argjson preAllocatedVUs "$pre_allocated_vus" \
  --argjson maxVus "$max_vus" \
  --argjson drainTimeoutSecs "$drain_timeout_secs" \
  --argjson businessSuccessThreshold "$business_success_threshold" \
  --argjson loadMonitorIntervalSecs "$load_monitor_interval_secs" \
  --argjson embeddingWorkerReplicas "$embedding_replicas" \
  --argjson reservationWorkerReplicas "$reservation_replicas" \
  --arg annEnabled "${RTB_MATCHER_ANN_ENABLED:-${ann_enabled:-}}" \
  --arg campaignSource "${RTB_CAMPAIGN_SOURCE:-${campaign_source_flag:-}}" \
  --arg contextDecision "${RTB_CONTEXT_DECISION_ENABLED:-${context_decision_flag:-}}" \
  --arg budgetMode "${RTB_BUDGET_MODE:-${budget_mode_flag:-}}" \
  --arg datasetHash "$dataset_hash" \
  --arg backendImage "$backend_image" \
  --arg backendComposeImage "$backend_compose" \
  '{
    runId: $runId,
    kind: "phase3-content",
    evidence: "PROVISIONAL",
    gitSha: $gitSha,
    gitDiffSha: $gitDiffSha,
    RATE: $rate,
    DURATION: $duration,
    durationSec: $durationSec,
    PRE_ALLOCATED_VUS: $preAllocatedVUs,
    MAX_VUS: $maxVus,
    drainTimeoutSecs: $drainTimeoutSecs,
    businessSuccessThreshold: $businessSuccessThreshold,
    loadMonitorIntervalSecs: $loadMonitorIntervalSecs,
    services: {
      embeddingWorkerReplicas: $embeddingWorkerReplicas,
      reservationWorkerReplicas: $reservationWorkerReplicas
    },
    profiles: ($profiles | split(" ") | map(select(length > 0))),
    RTB_MATCHER_ANN_ENABLED: $annEnabled,
    RTB_CAMPAIGN_SOURCE: $campaignSource,
    RTB_CONTEXT_DECISION_ENABLED: $contextDecision,
    RTB_BUDGET_MODE: $budgetMode,
    datasetHash: $datasetHash,
    corpusHash: $datasetHash,
    backend: {imageId: $backendImage, composeImage: $backendComposeImage}
  }' >"${output_root}/manifest.json"

if [ "$embedding_replicas" -ne "$expected_embedding_replicas" ] || \
  [ "$reservation_replicas" -ne "$expected_reservation_replicas" ]; then
  jq -n \
    --argjson embeddingActual "$embedding_replicas" \
    --argjson embeddingExpected "$expected_embedding_replicas" \
    --argjson reservationActual "$reservation_replicas" \
    --argjson reservationExpected "$expected_reservation_replicas" \
    '{
      suiteFailed:1,
      valid:false,
      reason:"worker_replica_contract_mismatch",
      embeddingWorker:{actual:$embeddingActual,expected:$embeddingExpected},
      reservationWorker:{actual:$reservationActual,expected:$reservationExpected}
    }' >"${output_root}/suite_verdict.json"
  exit 1
fi

reset_state() {
  local output="$1"
  (
    cd "$loadtest_dir"
    RESET_ONLY=true RESET_OUTPUT="$output" \
    EXPECTED_CAMPAIGN_COUNT="${EXPECTED_CAMPAIGN_COUNT:-1000}" \
    LOADTEST_RESET_TOKEN="${LOADTEST_RESET_TOKEN:-}" \
    RESET_BASE_URL="${RESET_BASE_URL:-$base_url}" \
      scripts/reset_and_run_k6.sh local
  )
}

# Avoid winner_only cliff on hot/mixed. Mutate only campaign:keys members.
boost_campaign_budgets() {
  apply_stable_budget
}

drain_embedding_queue() {
  local timeout="$1"
  local samples_file="$2"
  local elapsed=0
  local wait active delayed

  printf 'elapsed_sec\twait\tactive\tdelayed\n' >"$samples_file"
  while [ "$elapsed" -le "$timeout" ]; do
    read -r wait active delayed <<<"$(embedding_queue_counts)"
    printf '%s\t%s\t%s\t%s\n' "$elapsed" "$wait" "$active" "$delayed" \
      >>"$samples_file"
    if [ "$wait" -eq 0 ] && [ "$active" -eq 0 ] && [ "$delayed" -eq 0 ]; then
      printf '%s\n' "$elapsed"
      return 0
    fi
    sleep 1
    elapsed=$((elapsed + 1))
  done

  printf '%s\n' "$timeout"
  return 1
}

monitor_embedding_queue() {
  local output="$1"
  local interval="$2"
  local elapsed=0
  local wait active delayed failed

  printf 'elapsed_sec\twait\tactive\tdelayed\tfailed\n' >"$output"
  while true; do
    read -r wait active delayed <<<"$(embedding_queue_counts)"
    failed="$(embedding_failed_job_count)"
    printf '%s\t%s\t%s\t%s\t%s\n' \
      "$elapsed" "$wait" "$active" "$delayed" "$failed" >>"$output"
    sleep "$interval"
    elapsed=$((elapsed + interval))
  done
}

run_content_profile() {
  local name="$1"
  local mode="$2"
  local cell_dir="${output_root}/${name}"
  mkdir -p "$cell_dir"
  printf '[phase3] start %s mode=%s rate=%s duration=%s vus=%s/%s\n' \
    "$name" "$mode" "$rate" "$duration" "$pre_allocated_vus" "$max_vus"

  if ! assert_embedding_queue_empty "${name}-pre"; then
    jq -n --arg profile "$name" \
      '{profile:$profile,pass:false,valid:false,reason:"embedding_queue_not_empty"}' \
      >"${cell_dir}/verdict.json"
    return 1
  fi
  read -r q_wait_before q_active_before q_delayed_before <<<"$(embedding_queue_counts)"
  printf '%s %s %s\n' "$q_wait_before" "$q_active_before" "$q_delayed_before" \
    >"${cell_dir}/queue_before.txt"
  local failed_before
  failed_before="$(embedding_failed_job_count)"
  capture_loadtest_container_stats "${cell_dir}/container_stats_before.ndjson" || true

  reset_state "${cell_dir}/reset.json" || return 1
  if ! boost_campaign_budgets >"${cell_dir}/stable_budget.log" 2>&1; then
    cat "${cell_dir}/stable_budget.log" >&2 || true
    jq -n --arg profile "$name" \
      '{profile:$profile,pass:false,valid:false,reason:"stable_budget_assert_failed"}' \
      >"${cell_dir}/verdict.json"
    return 1
  fi
  cat "${cell_dir}/stable_budget.log"
  curl -fsS "${base_url}/api/metrics" >"${cell_dir}/metrics_before.txt"

  local -a k6_args=()
  if [ "$k6_quiet" = "true" ]; then
    k6_args+=(--quiet)
  fi
  local monitor_pid=""
  if [ "$load_monitor_interval_secs" -gt 0 ]; then
    monitor_embedding_queue \
      "${cell_dir}/queue_during_load.tsv" \
      "$load_monitor_interval_secs" &
    monitor_pid=$!
  fi
  (
    cd "$loadtest_dir"
    BASE_URL="$base_url" CONTENT_MODE="$mode" \
    RATE="$rate" DURATION="$duration" \
    HOT_POOL_SIZE="${HOT_POOL_SIZE:-40}" \
    PRE_ALLOCATED_VUS="$pre_allocated_vus" MAX_VUS="$max_vus" \
    BLOG_KEY="${BLOG_KEY:-test-blog}" \
      k6 run "${k6_args[@]}" --summary-export "${cell_dir}/k6_summary.json" \
        k6/http/rtb-decision-context-content.js
  ) 2>&1 | tee "${cell_dir}/k6_stdout.txt"
  local k6_rc=${PIPESTATUS[0]}
  if [ -n "$monitor_pid" ]; then
    kill "$monitor_pid" 2>/dev/null || true
    wait "$monitor_pid" 2>/dev/null || true
  fi
  printf '%s\n' "$k6_rc" >"${cell_dir}/k6_exit_code.txt"
  # Preserve raw artifacts regardless of threshold/k6 outcome.
  curl -fsS "${base_url}/api/metrics" >"${cell_dir}/metrics_after.txt"
  read -r q_wait_after q_active_after q_delayed_after <<<"$(embedding_queue_counts)"
  printf '%s %s %s\n' "$q_wait_after" "$q_active_after" "$q_delayed_after" \
    >"${cell_dir}/queue_after.txt"
  capture_loadtest_container_stats "${cell_dir}/container_stats_after_load.ndjson" || true

  local drain_seconds drained=false
  if drain_seconds="$(drain_embedding_queue "$drain_timeout_secs" "${cell_dir}/drain_samples.tsv")"; then
    drained=true
  fi
  local q_wait_final q_active_final q_delayed_final failed_after failed_delta
  read -r q_wait_final q_active_final q_delayed_final <<<"$(embedding_queue_counts)"
  printf '%s %s %s\n' "$q_wait_final" "$q_active_final" "$q_delayed_final" \
    >"${cell_dir}/queue_final.txt"
  failed_after="$(embedding_failed_job_count)"
  failed_delta=$((failed_after - failed_before))
  capture_loadtest_container_stats "${cell_dir}/container_stats_after_drain.ndjson" || true

  if [ -f "${cell_dir}/k6_summary.json" ]; then
    ANALYZE_DURATION_SEC="$duration_sec" \
    node "${script_dir}/analyze_rtb_cell.mjs" \
      "${cell_dir}/k6_summary.json" \
      "${cell_dir}/metrics_before.txt" \
      "${cell_dir}/metrics_after.txt" \
      "${cell_dir}/analysis.json" \
      >"${cell_dir}/analysis.stdout.json"
  else
    return 1
  fi

  write_cell_summary \
    "${cell_dir}/analysis.json" \
    "-" \
    "${cell_dir}/cell_summary.json" \
    "$duration_sec" \
    "$rate" \
    "true"

  local biz runtime lexical_count context_src dropped l1_hit l2_hit
  local p50 p95 p99 max_ms completed_rps context_fraction
  biz="$(jq -r '.k6.businessSuccessRate // 0' "${cell_dir}/analysis.json")"
  runtime="$(jq -r '.server.embedding.runtime // 0' "${cell_dir}/analysis.json")"
  lexical_count="$(jq -r '(.server.lexicalFallback.total // 0)' "${cell_dir}/analysis.json")"
  context_src="$(jq -r '.server.embedding.source.context // 0' "${cell_dir}/analysis.json")"
  dropped="$(jq -r '.k6.droppedIterations // 0' "${cell_dir}/analysis.json")"
  l1_hit="$(jq -r '(.server.context.cache.l1_hit // 0)' "${cell_dir}/analysis.json")"
  l2_hit="$(jq -r '(.server.context.cache.l2_hit // 0)' "${cell_dir}/analysis.json")"
  p50="$(jq -r '.k6.successOnly.med // .k6.p50Ms // 0' "${cell_dir}/analysis.json")"
  p95="$(jq -r '.k6.successOnly.p95 // .k6.p95Ms // 0' "${cell_dir}/analysis.json")"
  p99="$(jq -r '.k6.successOnly.p99 // .k6.p99Ms // 0' "${cell_dir}/analysis.json")"
  max_ms="$(jq -r '.k6.successOnly.max // .k6.maxMs // 0' "${cell_dir}/analysis.json")"
  completed_rps="$(jq -r '.k6.completedRps // 0' "${cell_dir}/analysis.json")"
  context_fraction="$(awk -v c="$context_src" -v l="$lexical_count" \
    'BEGIN { total=c+l; if (total==0) print 0; else printf "%.6f", c/total }')"

  local pass=false
  case "$mode" in
    hot)
      # warm: context used, runtime≈0, lexical≈0, success high, no drop, p95 bound
      if awk -v b="$biz" -v threshold="$business_success_threshold" \
        -v r="$runtime" -v d="$dropped" -v h="$l1_hit" -v p="$p95" \
        -v f="$context_fraction" -v drained="$drained" -v failed="$failed_delta" \
        'BEGIN{exit !((b+0)>=threshold && (r+0)==0 && (d+0)==0 && (h+0)>0 && (p+0)<300 && (f+0)>=0.98 && drained=="true" && (failed+0)==0)}'; then
        pass=true
      fi
      ;;
    cold)
      if awk -v b="$biz" -v threshold="$business_success_threshold" \
        -v r="$runtime" -v d="$dropped" -v l="$lexical_count" -v p="$p95" \
        -v f="$context_fraction" -v drained="$drained" -v failed="$failed_delta" \
        'BEGIN{exit !((b+0)>=threshold && (r+0)==0 && (d+0)==0 && (l+0)>0 && (p+0)<300 && (f+0)<=0.02 && drained=="true" && (failed+0)==0)}'; then
        pass=true
      fi
      ;;
    mixed)
      if awk -v b="$biz" -v threshold="$business_success_threshold" \
        -v r="$runtime" -v d="$dropped" -v c="$context_src" -v l="$lexical_count" \
        -v p="$p95" -v f="$context_fraction" -v drained="$drained" -v failed="$failed_delta" \
        'BEGIN{exit !((b+0)>=threshold && (r+0)==0 && (d+0)==0 && (c+0)>0 && (l+0)>0 && (p+0)<300 && (f+0)>=0.60 && (f+0)<=0.80 && drained=="true" && (failed+0)==0)}'; then
        pass=true
      fi
      ;;
  esac

  jq -n \
    --arg profile "$name" --arg mode "$mode" --argjson pass "$pass" \
    --argjson biz "$biz" --argjson runtime "$runtime" --argjson contextSrc "$context_src" \
    --argjson lexical "$lexical_count" --argjson l1Hit "$l1_hit" --argjson l2Hit "$l2_hit" \
    --argjson dropped "$dropped" \
    --argjson p50 "$p50" --argjson p95 "$p95" --argjson p99 "$p99" --argjson maxMs "$max_ms" \
    --argjson completedRps "$completed_rps" \
    --argjson contextFraction "$context_fraction" \
    --argjson queueWaitBefore "$q_wait_before" --argjson queueWaitAfter "$q_wait_after" \
    --argjson queueWaitFinal "$q_wait_final" --argjson queueActiveFinal "$q_active_final" \
    --argjson queueDelayedFinal "$q_delayed_final" --argjson drainSeconds "$drain_seconds" \
    --argjson drained "$drained" --argjson failedJobDelta "$failed_delta" \
    --argjson embeddingWorkerReplicas "$embedding_replicas" \
    --argjson reservationWorkerReplicas "$reservation_replicas" \
    '{
      profile:$profile,mode:$mode,pass:$pass,
      businessSuccessRate:$biz,runtime:$runtime,contextSource:$contextSrc,
      lexical:$lexical,l1Hit:$l1Hit,l2Hit:$l2Hit,droppedIterations:$dropped,
      contextFraction:$contextFraction,
      successOnly:{p50:$p50,p95:$p95,p99:$p99,max:$maxMs},
      completedRps:$completedRps,
      queue:{
        waitBefore:$queueWaitBefore,
        waitAfterLoad:$queueWaitAfter,
        waitFinal:$queueWaitFinal,
        activeFinal:$queueActiveFinal,
        delayedFinal:$queueDelayedFinal,
        drained:$drained,
        drainSeconds:$drainSeconds
      },
      failedJobDelta:$failedJobDelta,
      services:{
        embeddingWorkerReplicas:$embeddingWorkerReplicas,
        reservationWorkerReplicas:$reservationWorkerReplicas
      },
      evidence:"PROVISIONAL"
    }' >"${cell_dir}/verdict.json"

  # Do not abort remaining profiles on threshold/verdict failure.
  jq -e '.pass == true' "${cell_dir}/verdict.json" >/dev/null
}

run_concurrent_same() {
  local cell_dir="${output_root}/concurrent-same-content"
  mkdir -p "$cell_dir"
  local title="concurrent-${run_id}"
  printf '[phase3] start concurrent-same-content\n'
  reset_state "${cell_dir}/reset.json" || return 1
  curl -fsS "${base_url}/api/metrics" >"${cell_dir}/metrics_before.txt"
  # burst observes
  for i in $(seq 1 40); do
    curl -fsS -X POST "${base_url}/api/sdk/context/observe" \
      -H 'Content-Type: application/json' \
      --data "{\"blogKey\":\"test-blog\",\"postUrl\":\"http://127.0.0.1/posts/${title}\",\"title\":\"${title}\",\"body\":\"same body\",\"tags\":[\"typescript\"]}" \
      >"${cell_dir}/observe_${i}.json" &
  done
  wait
  curl -fsS "${base_url}/api/metrics" >"${cell_dir}/metrics_after.txt"
  local enq dedup
  enq="$(awk '$1 ~ /boostad_rtb_context_job_total\{/ && $1 ~ /result="enqueued"/ {s+=$2} END{print s+0}' "${cell_dir}/metrics_after.txt")"
  enq_b="$(awk '$1 ~ /boostad_rtb_context_job_total\{/ && $1 ~ /result="enqueued"/ {s+=$2} END{print s+0}' "${cell_dir}/metrics_before.txt")"
  dedup="$(awk '$1 ~ /boostad_rtb_context_job_total\{/ && $1 ~ /result="deduplicated"/ {s+=$2} END{print s+0}' "${cell_dir}/metrics_after.txt")"
  dedup_b="$(awk '$1 ~ /boostad_rtb_context_job_total\{/ && $1 ~ /result="deduplicated"/ {s+=$2} END{print s+0}' "${cell_dir}/metrics_before.txt")"
  local enq_d=$((enq-enq_b)) dedup_d=$((dedup-dedup_b))
  local pass=false
  if [ "$enq_d" -eq 1 ] && [ "$dedup_d" -ge 1 ]; then pass=true; fi
  jq -n --argjson enqueued "$enq_d" --argjson deduplicated "$dedup_d" --argjson pass "$pass" \
    '{profile:"concurrent-same-content",enqueued:$enqueued,deduplicated:$deduplicated,pass:$pass}' \
    >"${cell_dir}/verdict.json"
  jq -e '.pass == true' "${cell_dir}/verdict.json" >/dev/null
}

run_multi_instance() {
  local cell_dir="${output_root}/multi-instance"
  mkdir -p "$cell_dir"
  local title="multi-${run_id}"
  printf '[phase3] start multi-instance\n'
  if ! curl -fsS "${base_url_b}/api/metrics" >"${cell_dir}/b_probe.txt"; then
    jq -n '{profile:"multi-instance",pass:false,valid:false,reason:"backend-b down"}' >"${cell_dir}/verdict.json"
    return 1
  fi
  # observe on A until READY
  local context_id="" status=""
  for i in $(seq 1 60); do
    local obs
    obs="$(curl -fsS -X POST "${base_url}/api/sdk/context/observe" \
      -H 'Content-Type: application/json' \
      --data "{\"blogKey\":\"test-blog\",\"postUrl\":\"http://127.0.0.1/posts/${title}\",\"title\":\"${title}\",\"body\":\"multi body\",\"tags\":[\"typescript\",\"react\"]}")"
    context_id="$(jq -r '.contextId' <<<"$obs")"
    status="$(jq -r '.status' <<<"$obs")"
    if [ "$status" = "READY" ]; then break; fi
    sleep 2
  done
  test "$status" = "READY"
  curl -fsS "${base_url_b}/api/metrics" >"${cell_dir}/b_before.txt"
  curl -fsS -X POST "${base_url_b}/api/sdk/decision" \
    -H 'Content-Type: application/json' \
    --data "{\"blogKey\":\"test-blog\",\"postUrl\":\"http://127.0.0.1/posts/${title}\",\"tags\":[\"typescript\",\"react\"],\"behaviorScore\":50,\"isHighIntent\":false,\"contextId\":\"${context_id}\"}" \
    >"${cell_dir}/decision_b1.json"
  curl -fsS "${base_url_b}/api/metrics" >"${cell_dir}/b_after1.txt"
  curl -fsS -X POST "${base_url_b}/api/sdk/decision" \
    -H 'Content-Type: application/json' \
    --data "{\"blogKey\":\"test-blog\",\"postUrl\":\"http://127.0.0.1/posts/${title}-2\",\"tags\":[\"typescript\",\"react\"],\"behaviorScore\":50,\"isHighIntent\":false,\"contextId\":\"${context_id}\"}" \
    >"${cell_dir}/decision_b2.json"
  curl -fsS "${base_url_b}/api/metrics" >"${cell_dir}/b_after2.txt"
  local l2_1 l2_2 l1_2
  l2_1="$(awk '$1 ~ /boostad_rtb_context_cache_total\{/ && $1 ~ /result="l2_hit"/ {s+=$2} END{print s+0}' "${cell_dir}/b_after1.txt")"
  l2_0="$(awk '$1 ~ /boostad_rtb_context_cache_total\{/ && $1 ~ /result="l2_hit"/ {s+=$2} END{print s+0}' "${cell_dir}/b_before.txt")"
  l1_2="$(awk '$1 ~ /boostad_rtb_context_cache_total\{/ && $1 ~ /result="l1_hit"/ {s+=$2} END{print s+0}' "${cell_dir}/b_after2.txt")"
  l1_1="$(awk '$1 ~ /boostad_rtb_context_cache_total\{/ && $1 ~ /result="l1_hit"/ {s+=$2} END{print s+0}' "${cell_dir}/b_after1.txt")"
  local pass=false
  if [ "$((l2_1-l2_0))" -ge 1 ] && [ "$((l1_2-l1_1))" -ge 1 ]; then pass=true; fi
  jq -n --argjson pass "$pass" --argjson bL2 "$((l2_1-l2_0))" --argjson bL1 "$((l1_2-l1_1))" \
    '{profile:"multi-instance",pass:$pass,bL2HitDelta:$bL2,bL1HitDelta:$bL1,valid:true}' \
    >"${cell_dir}/verdict.json"
  jq -e '.pass == true' "${cell_dir}/verdict.json" >/dev/null
}

run_worker_down() {
  local cell_dir="${output_root}/worker-down"
  mkdir -p "$cell_dir"
  printf '[phase3] start worker-down\n'
  stop_embedding_workers >/dev/null 2>&1 || true
  local title="worker-down-${run_id}"
  curl -fsS "${base_url}/api/metrics" >"${cell_dir}/metrics_before.txt"
  local obs
  obs="$(curl -fsS -X POST "${base_url}/api/sdk/context/observe" \
    -H 'Content-Type: application/json' \
    --data "{\"blogKey\":\"test-blog\",\"postUrl\":\"http://127.0.0.1/posts/${title}\",\"title\":\"${title}\",\"body\":\"wd\",\"tags\":[\"typescript\"]}")"
  printf '%s\n' "$obs" >"${cell_dir}/observe.json"
  test "$(jq -r '.status' <<<"$obs")" = "PENDING"
  local ctx; ctx="$(jq -r '.contextId' <<<"$obs")"
  local dec
  dec="$(curl -fsS -X POST "${base_url}/api/sdk/decision" \
    -H 'Content-Type: application/json' \
    --data "{\"blogKey\":\"test-blog\",\"postUrl\":\"http://127.0.0.1/posts/${title}\",\"tags\":[\"typescript\"],\"behaviorScore\":50,\"isHighIntent\":false,\"contextId\":\"${ctx}\"}")"
  printf '%s\n' "$dec" >"${cell_dir}/decision.json"
  jq -e '.status == "success"' <<<"$dec" >/dev/null
  curl -fsS "${base_url}/api/metrics" >"${cell_dir}/metrics_after.txt"
  local rt_b rt_a lex_b lex_a
  rt_b="$(awk '$1=="boostad_rtb_embedding_runtime_total"{s+=$2} END{print s+0}' "${cell_dir}/metrics_before.txt")"
  rt_a="$(awk '$1=="boostad_rtb_embedding_runtime_total"{s+=$2} END{print s+0}' "${cell_dir}/metrics_after.txt")"
  lex_b="$(awk '$1 ~ /^boostad_rtb_lexical_fallback_total/ {s+=$2} END{print s+0}' "${cell_dir}/metrics_before.txt")"
  lex_a="$(awk '$1 ~ /^boostad_rtb_lexical_fallback_total/ {s+=$2} END{print s+0}' "${cell_dir}/metrics_after.txt")"
  local pass=false
  if [ "$((rt_a-rt_b))" -eq 0 ] && [ "$((lex_a-lex_b))" -ge 1 ]; then pass=true; fi
  start_embedding_workers >/dev/null 2>&1 || true
  # give worker a moment after restart
  sleep 3
  jq -n --argjson pass "$pass" --argjson runtimeDelta "$((rt_a-rt_b))" --argjson lexicalDelta "$((lex_a-lex_b))" \
    '{profile:"worker-down",pass:$pass,runtimeDelta:$runtimeDelta,lexicalDelta:$lexicalDelta}' \
    >"${cell_dir}/verdict.json"
  jq -e '.pass == true' "${cell_dir}/verdict.json" >/dev/null
}

queue_wait_len() {
  redis_cli LLEN "$(embedding_queue_key wait)" 2>/dev/null || echo 0
}

run_queue_pressure() {
  local cell_dir="${output_root}/queue-pressure"
  mkdir -p "$cell_dir"
  printf '[phase3] start queue-pressure\n'
  reset_state "${cell_dir}/reset.json" || return 1
  # ensure worker is up
  start_embedding_workers >/dev/null 2>&1 || true
  sleep 2
  curl -fsS "${base_url}/api/metrics" >"${cell_dir}/metrics_before.txt"
  local wait_before; wait_before="$(queue_wait_len)"
  printf '%s\n' "$wait_before" >"${cell_dir}/wait_before.txt"

  local burst_secs="${QUEUE_PRESSURE_SECS:-20}"
  local burst_rps="${QUEUE_PRESSURE_RPS:-40}"
  local end=$((SECONDS + burst_secs))
  local i=0
  # unique observe flood faster than typical single-worker Xenova throughput
  while [ "$SECONDS" -lt "$end" ]; do
    local batch=0
    while [ "$batch" -lt "$burst_rps" ]; do
      i=$((i + 1))
      batch=$((batch + 1))
      curl -fsS -X POST "${base_url}/api/sdk/context/observe" \
        -H 'Content-Type: application/json' \
        --data "{\"blogKey\":\"test-blog\",\"postUrl\":\"http://127.0.0.1/posts/qp-${run_id}-${i}\",\"title\":\"qp ${run_id} ${i}\",\"body\":\"unique body ${i} typescript nestjs\",\"tags\":[\"typescript\"]}" \
        >"${cell_dir}/obs_${i}.json" 2>/dev/null &
    done
    wait
    queue_wait_len >>"${cell_dir}/wait_samples.txt"
  done

  local wait_peak; wait_peak="$(queue_wait_len)"
  printf '%s\n' "$wait_peak" >"${cell_dir}/wait_at_end_of_burst.txt"
  curl -fsS "${base_url}/api/metrics" >"${cell_dir}/metrics_after_burst.txt"

  # recovery window: backlog must not keep growing after load stops
  local recover_secs="${QUEUE_RECOVER_SECS:-90}"
  local prev="$wait_peak"
  local recovered=0
  local grew_after_stop=0
  local t=0
  while [ "$t" -lt "$recover_secs" ]; do
    sleep 5
    t=$((t + 5))
    local cur; cur="$(queue_wait_len)"
    printf '%s %s\n' "$t" "$cur" >>"${cell_dir}/recover_samples.txt"
    if [ "$cur" -gt "$prev" ]; then grew_after_stop=1; fi
    if [ "$cur" -lt "$wait_peak" ]; then recovered=1; fi
    if [ "$cur" -eq 0 ]; then recovered=1; break; fi
    prev="$cur"
  done
  local wait_final; wait_final="$(queue_wait_len)"
  curl -fsS "${base_url}/api/metrics" >"${cell_dir}/metrics_after_recover.txt"

  local enq_b enq_a done_b done_a
  enq_b="$(awk '$1 ~ /boostad_rtb_context_job_total\{/ && $1 ~ /result="enqueued"/ {s+=$2} END{print s+0}' "${cell_dir}/metrics_before.txt")"
  enq_a="$(awk '$1 ~ /boostad_rtb_context_job_total\{/ && $1 ~ /result="enqueued"/ {s+=$2} END{print s+0}' "${cell_dir}/metrics_after_burst.txt")"
  done_b="$(awk '$1 ~ /boostad_rtb_context_job_total\{/ && $1 ~ /result="completed"/ {s+=$2} END{print s+0}' "${cell_dir}/metrics_before.txt")"
  done_a="$(awk '$1 ~ /boostad_rtb_context_job_total\{/ && $1 ~ /result="completed"/ {s+=$2} END{print s+0}' "${cell_dir}/metrics_after_recover.txt")"

  # PASS: after burst stops, waiting does not keep rising AND shows recovery trend (or drains)
  local pass=false
  if [ "$grew_after_stop" -eq 0 ] && [ "$recovered" -eq 1 ]; then pass=true; fi
  # also require we actually created pressure
  if [ "$wait_peak" -le "$wait_before" ] && [ "$((enq_a-enq_b))" -lt 10 ]; then pass=false; fi

  jq -n \
    --argjson pass "$pass" \
    --argjson waitBefore "$wait_before" \
    --argjson waitPeak "$wait_peak" \
    --argjson waitFinal "$wait_final" \
    --argjson enqueued "$((enq_a-enq_b))" \
    --argjson completed "$((done_a-done_b))" \
    --argjson grewAfterStop "$grew_after_stop" \
    --argjson recovered "$recovered" \
    '{profile:"queue-pressure",pass:$pass,waitBefore:$waitBefore,waitPeak:$waitPeak,waitFinal:$waitFinal,enqueued:$enqueued,completed:$completed,grewAfterStop:($grewAfterStop==1),recovered:($recovered==1)}' \
    >"${cell_dir}/verdict.json"
  jq -e '.pass == true' "${cell_dir}/verdict.json" >/dev/null
}

for profile in $profiles; do
  case "$profile" in
    hot-content) run_content_profile hot-content hot || suite_failed=1 ;;
    cold-content) run_content_profile cold-content cold || suite_failed=1 ;;
    mixed-content) run_content_profile mixed-content mixed || suite_failed=1 ;;
    concurrent-same-content) run_concurrent_same || suite_failed=1 ;;
    multi-instance) run_multi_instance || suite_failed=1 ;;
    worker-down) run_worker_down || suite_failed=1 ;;
    queue-pressure) run_queue_pressure || suite_failed=1 ;;
    second-visit)
      OUTPUT_DIR="${output_root}/second-visit" \
        "${script_dir}/run_rtb_phase3_e2e.sh" || suite_failed=1
      ;;
    *) echo "unknown profile $profile"; suite_failed=1 ;;
  esac
done

jq -n --argjson failed "$suite_failed" \
  --argjson productPass "$( [ "$suite_failed" -eq 0 ] && echo true || echo false )" \
  '{suiteFailed:$failed,productPass:$productPass,evidence:"PROVISIONAL"}' \
  >"${output_root}/suite_verdict.json"
exit "$suite_failed"
