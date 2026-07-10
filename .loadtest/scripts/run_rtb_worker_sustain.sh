#!/usr/bin/env bash
# Measure context-embedding worker sustained throughput and full queue drain.
# Uses BullMQ Redis keys (wait/active/delayed), not API process CPU metrics.
set -uo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
loadtest_dir="$(cd "${script_dir}/.." && pwd)"
repo_root="$(cd "${loadtest_dir}/.." && pwd)"

# shellcheck source=loadtest_common.sh
source "${script_dir}/loadtest_common.sh"

base_url="${BASE_URL:-http://127.0.0.1:3000}"
run_id="${RUN_ID:-$(date +%Y%m%d-%H%M%S)-worker-sustain}"
output_root="${OUTPUT_DIR:-${loadtest_dir}/results/${run_id}}"
rates="${RATES:-10 20 30}"
load_secs="${LOAD_SECS:-60}"
drain_timeout_secs="${DRAIN_TIMEOUT_SECS:-300}"
suite_failed=0

mkdir -p "$output_root"

git_sha="$(git -C "$repo_root" rev-parse HEAD 2>/dev/null || echo unknown)"
git_diff_sha="$(git -C "$repo_root" diff --binary 2>/dev/null | shasum -a 256 | awk '{print $1}')"
backend_image="$(backend_image_id)"
capture_backend_flags >"${output_root}/backend_env.txt" || true

jq -n \
  --arg runId "$run_id" \
  --arg rates "$rates" \
  --argjson loadSecs "$load_secs" \
  --argjson drainTimeoutSecs "$drain_timeout_secs" \
  --arg gitSha "$git_sha" \
  --arg gitDiffSha "$git_diff_sha" \
  --arg backendImage "$backend_image" \
  '{
    runId:$runId,
    kind:"worker-sustain",
    evidence:"PROVISIONAL",
    rates:($rates|split(" ")|map(tonumber)),
    loadSecs:$loadSecs,
    drainTimeoutSecs:$drainTimeoutSecs,
    gitSha:$gitSha,
    gitDiffSha:$gitDiffSha,
    backend:{imageId:$backendImage}
  }' >"${output_root}/manifest.json"

require_worker_up() {
  if ! docker ps --format '{{.Names}}' | grep -qx 'boostad-backend-worker-local'; then
    docker start boostad-backend-worker-local >/dev/null 2>&1 || true
    sleep 3
  fi
  if ! docker ps --format '{{.Names}}' | grep -qx 'boostad-backend-worker-local'; then
    printf '[worker-sustain] backend-worker not running\n' >&2
    return 1
  fi
}

drain_queue_fully() {
  local timeout="$1"
  local label="$2"
  local t=0
  local wait active delayed
  while [ "$t" -lt "$timeout" ]; do
    read -r wait active delayed <<<"$(embedding_queue_counts)"
    if [ "${wait:-0}" -eq 0 ] && [ "${active:-0}" -eq 0 ] && [ "${delayed:-0}" -eq 0 ]; then
      printf '[worker-sustain] queue drained (%s) after %ss\n' "$label" "$t"
      return 0
    fi
    sleep 1
    t=$((t + 1))
  done
  read -r wait active delayed <<<"$(embedding_queue_counts)"
  printf '[worker-sustain] queue NOT drained (%s): wait=%s active=%s delayed=%s after %ss\n' \
    "$label" "$wait" "$active" "$delayed" "$timeout" >&2
  return 1
}

runtime_inference_total() {
  local metrics_file="$1"
  awk '$1=="boostad_rtb_embedding_runtime_total"{s+=$2} END{print s+0}' "$metrics_file"
}

failed_jobs() {
  docker exec boostad-redis-master-local redis-cli ZCARD bull:embedding-queue:failed 2>/dev/null || echo 0
}

run_rate_cell() {
  local rps="$1"
  local cell_dir="${output_root}/observe-r${rps}"
  mkdir -p "$cell_dir"
  printf '[worker-sustain] start unique-observe rate=%s for %ss\n' "$rps" "$load_secs"

  require_worker_up || return 1

  if ! assert_embedding_queue_empty "r${rps}-pre"; then
    # Attempt drain once before failing the cell.
    drain_queue_fully 120 "r${rps}-pre-drain" || true
    if ! assert_embedding_queue_empty "r${rps}-pre-retry"; then
      jq -n --argjson rate "$rps" \
        '{rate:$rate,pass:false,recoveryPass:false,reason:"queue_not_empty_before_start"}' \
        >"${cell_dir}/verdict.json"
      return 1
    fi
  fi

  curl -fsS "${base_url}/api/metrics" >"${cell_dir}/metrics_before.txt"
  local runtime_before failed_before
  runtime_before="$(runtime_inference_total "${cell_dir}/metrics_before.txt")"
  failed_before="$(failed_jobs)"

  : >"${cell_dir}/wait_samples.tsv"
  printf 'elapsed_sec\twait\tactive\tdelayed\tenqueued_this_sec\n' >"${cell_dir}/wait_samples.tsv"

  local enqueued=0
  local peak_wait=0
  local wait_start=0
  local slope_rising=0
  local prev_wait=0
  local rising_streak=0
  local i=0
  local sec=0
  local end=$((SECONDS + load_secs))
  local cell_start=$SECONDS

  read -r wait_start _ _ <<<"$(embedding_queue_counts)"
  prev_wait="$wait_start"

  while [ "$SECONDS" -lt "$end" ]; do
    local batch_start=$SECONDS
    local batch=0
    while [ "$batch" -lt "$rps" ]; do
      i=$((i + 1))
      batch=$((batch + 1))
      enqueued=$((enqueued + 1))
      curl -fsS -X POST "${base_url}/api/sdk/context/observe" \
        -H 'Content-Type: application/json' \
        --data "{\"blogKey\":\"test-blog\",\"postUrl\":\"http://127.0.0.1/posts/ws-${run_id}-r${rps}-${i}\",\"title\":\"ws ${run_id} r${rps} ${i}\",\"body\":\"unique sustain body ${i} typescript nestjs react\",\"tags\":[\"typescript\",\"nestjs\"]}" \
        >"${cell_dir}/obs_${i}.json" 2>/dev/null &
    done
    wait

    # Pace to ~1s wall per batch
    local elapsed_batch=$((SECONDS - batch_start))
    if [ "$elapsed_batch" -lt 1 ]; then
      sleep $((1 - elapsed_batch))
    fi

    sec=$((SECONDS - cell_start))
    local wait active delayed
    read -r wait active delayed <<<"$(embedding_queue_counts)"
    printf '%s\t%s\t%s\t%s\t%s\n' "$sec" "$wait" "$active" "$delayed" "$batch" \
      >>"${cell_dir}/wait_samples.tsv"
    if [ "$wait" -gt "$peak_wait" ]; then peak_wait="$wait"; fi
    if [ "$wait" -gt "$prev_wait" ]; then
      rising_streak=$((rising_streak + 1))
    else
      rising_streak=0
    fi
    # Sustained rise for >= half the load window ⇒ over capacity
    if [ "$rising_streak" -ge $((load_secs / 2)) ]; then
      slope_rising=1
    fi
    prev_wait="$wait"
  done

  local wait_at_stop active_at_stop delayed_at_stop
  read -r wait_at_stop active_at_stop delayed_at_stop <<<"$(embedding_queue_counts)"
  printf '%s %s %s\n' "$wait_at_stop" "$active_at_stop" "$delayed_at_stop" \
    >"${cell_dir}/queue_at_load_end.txt"
  curl -fsS "${base_url}/api/metrics" >"${cell_dir}/metrics_after_load.txt"

  # Drain observation (max 5 minutes)
  local drain_start=$SECONDS
  local drain_secs=-1
  local recovered=0
  local t=0
  : >"${cell_dir}/drain_samples.tsv"
  printf 'elapsed_sec\twait\tactive\tdelayed\n' >"${cell_dir}/drain_samples.tsv"
  while [ "$t" -lt "$drain_timeout_secs" ]; do
    local wait active delayed
    read -r wait active delayed <<<"$(embedding_queue_counts)"
    printf '%s\t%s\t%s\t%s\n' "$t" "$wait" "$active" "$delayed" \
      >>"${cell_dir}/drain_samples.tsv"
    if [ "$wait" -eq 0 ] && [ "$active" -eq 0 ] && [ "$delayed" -eq 0 ]; then
      drain_secs=$t
      recovered=1
      break
    fi
    sleep 1
    t=$((t + 1))
  done
  if [ "$recovered" -eq 0 ]; then
    drain_secs=$drain_timeout_secs
  fi

  curl -fsS "${base_url}/api/metrics" >"${cell_dir}/metrics_after_drain.txt"
  local runtime_after failed_after
  runtime_after="$(runtime_inference_total "${cell_dir}/metrics_after_drain.txt")"
  failed_after="$(failed_jobs)"

  local wait_final active_final delayed_final
  read -r wait_final active_final delayed_final <<<"$(embedding_queue_counts)"

  # Worker throughput estimate: jobs cleared from peak backlog + processed during load.
  # Prefer (enqueued - wait_final) / (load + drain) when fully drained.
  local worker_rps="null"
  local total_wall=$((load_secs + drain_secs))
  if [ "$recovered" -eq 1 ] && [ "$total_wall" -gt 0 ]; then
    worker_rps="$(awk -v e="$enqueued" -v w="$total_wall" 'BEGIN{printf "%.3f", e/w}')"
  elif [ "$drain_secs" -gt 0 ] && [ "$wait_at_stop" -gt "$wait_final" ]; then
    worker_rps="$(awk -v a="$wait_at_stop" -v b="$wait_final" -v d="$drain_secs" \
      'BEGIN{printf "%.3f", (a-b)/d}')"
  fi

  local enqueue_rps
  enqueue_rps="$(awk -v e="$enqueued" -v s="$load_secs" 'BEGIN{printf "%.3f", e/s}')"

  local runtime_delta=$((runtime_after - runtime_before))
  local failed_delta=$((failed_after - failed_before))
  local recovery_pass=false
  local pass=false
  if [ "$recovered" -eq 1 ] && [ "$wait_final" -eq 0 ]; then
    recovery_pass=true
  fi
  # Cell pass: recovery + no decision runtime inference during observe-only load
  if [ "$recovery_pass" = "true" ] && [ "$runtime_delta" -eq 0 ] && [ "$slope_rising" -eq 0 ]; then
    pass=true
  fi

  jq -n \
    --argjson rate "$rps" \
    --argjson enqueued "$enqueued" \
    --argjson enqueueRps "$enqueue_rps" \
    --argjson workerRps "${worker_rps:-null}" \
    --argjson waitStart "$wait_start" \
    --argjson waitPeak "$peak_wait" \
    --argjson waitAtStop "$wait_at_stop" \
    --argjson waitFinal "$wait_final" \
    --argjson delayedFinal "$delayed_final" \
    --argjson failedDelta "$failed_delta" \
    --argjson drainSecs "$drain_secs" \
    --argjson slopeRising "$slope_rising" \
    --argjson runtimeDelta "$runtime_delta" \
    --argjson recoveryPass "$recovery_pass" \
    --argjson pass "$pass" \
    '{
      profile:"worker-sustain",
      rate:$rate,
      enqueued:$enqueued,
      enqueueRps:$enqueueRps,
      workerEstimatedRps:$workerRps,
      waiting:{start:$waitStart,peak:$waitPeak,atLoadEnd:$waitAtStop,final:$waitFinal},
      delayedFinal:$delayedFinal,
      failedJobDelta:$failedDelta,
      loadSlopeRising:($slopeRising==1),
      drainSeconds:$drainSecs,
      decisionRuntimeInferenceDelta:$runtimeDelta,
      recoveryPass:$recoveryPass,
      pass:$pass,
      evidence:"PROVISIONAL",
      notes:[
        "waiting=0 required for recovery PASS",
        "sustained waiting growth during load ⇒ rate exceeds worker capacity",
        "observe-only load; decision runtime inference should stay 0"
      ]
    }' >"${cell_dir}/verdict.json"

  printf '[worker-sustain] rate=%s enq=%s peakWait=%s drain=%ss recovery=%s pass=%s\n' \
    "$rps" "$enqueued" "$peak_wait" "$drain_secs" "$recovery_pass" "$pass"

  jq -e '.pass == true' "${cell_dir}/verdict.json" >/dev/null
}

for rps in $rates; do
  if ! run_rate_cell "$rps"; then
    suite_failed=1
  fi
  # Ensure next cell starts from empty queue (best-effort full drain).
  drain_queue_fully "$drain_timeout_secs" "between-rates" || suite_failed=1
done

jq -n --argjson failed "$suite_failed" \
  '{suiteFailed:$failed,evidence:"PROVISIONAL"}' \
  >"${output_root}/suite_verdict.json"
exit "$suite_failed"
