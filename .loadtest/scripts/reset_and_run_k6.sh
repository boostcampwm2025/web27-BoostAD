#!/usr/bin/env bash

set -euo pipefail

mode="${1:-docker}"

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
loadtest_dir="$(cd "${script_dir}/.." && pwd)"

require_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    printf 'required command not found: %s\n' "$1" >&2
    exit 1
  fi
}

require_cmd curl
require_cmd jq

trim() {
  local value="$1"
  value="${value#"${value%%[![:space:]]*}"}"
  value="${value%"${value##*[![:space:]]}"}"
  printf '%s' "$value"
}

bool_or_default() {
  local raw="${1:-}"
  local fallback="$2"
  case "${raw:-$fallback}" in
    true|false)
      printf '%s' "${raw:-$fallback}"
      ;;
    *)
      printf '%s' "$fallback"
      ;;
  esac
}

build_campaign_ids_json() {
  local raw="${RESET_CAMPAIGN_IDS:-}"
  local json=""

  if [ -z "$raw" ]; then
    printf ''
    return
  fi

  IFS=',' read -r -a parts <<<"$raw"
  for part in "${parts[@]}"; do
    local trimmed
    trimmed="$(trim "$part")"
    if [ -z "$trimmed" ]; then
      continue
    fi

    if [ -n "$json" ]; then
      json="${json},"
    fi
    json="${json}\"${trimmed}\""
  done

  if [ -n "$json" ]; then
    printf '"campaignIds":[%s],' "$json"
  fi
}

run_reset() {
  local reset_base_url="${RESET_BASE_URL:-http://localhost:3000}"
  local reset_path="${RESET_PATH:-/api/internal/loadtest/reset-rtb-state}"
  local reset_token="${LOADTEST_RESET_TOKEN:-}"
  local reset_force
  local reset_clear_logs
  local reset_clear_aux_redis_keys
  local reset_drain_bidlog_queue
  local campaign_ids_json
  local body
  local reset_output
  local expected_campaign_count

  if [ -z "$reset_token" ]; then
    printf 'LOADTEST_RESET_TOKEN is required to run reset wrapper.\n' >&2
    exit 1
  fi

  reset_force="$(bool_or_default "${RESET_FORCE:-}" "true")"
  reset_clear_logs="$(bool_or_default "${RESET_CLEAR_LOGS:-}" "true")"
  reset_clear_aux_redis_keys="$(bool_or_default "${RESET_CLEAR_AUX_REDIS_KEYS:-}" "true")"
  reset_drain_bidlog_queue="$(bool_or_default "${RESET_DRAIN_BIDLOG_QUEUE:-}" "true")"
  campaign_ids_json="$(build_campaign_ids_json)"

  body="$(printf '{%s"force":%s,"clearLogs":%s,"clearAuxRedisKeys":%s,"drainBidlogQueue":%s}' \
    "$campaign_ids_json" \
    "$reset_force" \
    "$reset_clear_logs" \
    "$reset_clear_aux_redis_keys" \
    "$reset_drain_bidlog_queue")"
  reset_output="${RESET_OUTPUT:-${loadtest_dir}/reset-response.json}"
  expected_campaign_count="${EXPECTED_CAMPAIGN_COUNT:-1000}"

  mkdir -p "$(dirname "$reset_output")"

  printf '[loadtest] resetting RTB state via %s%s\n' "$reset_base_url" "$reset_path" >&2
  curl --fail --silent --show-error \
    -X POST "${reset_base_url}${reset_path}" \
    -H 'Content-Type: application/json' \
    -H "x-loadtest-reset-token: ${reset_token}" \
    --data "$body" >"$reset_output"

  if ! jq -e \
    --argjson expected "$expected_campaign_count" \
    '
      .status == "success"
      and .data.counts.dbCampaignsReset == $expected
      and .data.counts.redisCampaignsReset == $expected
      and .data.queueAfter.active == 0
      and .data.queueAfter.waiting == 0
      and .data.queueAfter.delayed == 0
      and .data.queueAfter.prioritized == 0
    ' \
    "$reset_output" >/dev/null; then
    printf '[loadtest] reset assertion failed: %s\n' "$reset_output" >&2
    jq '.' "$reset_output" >&2 || true
    exit 1
  fi

  printf '[loadtest] reset assertion passed: %s campaigns (%s)\n' \
    "$expected_campaign_count" \
    "$reset_output" >&2
}

run_k6_docker() {
  local docker_run_args=()
  local docker_cmd=()
  if [ -n "${DOCKER_RUN_ARGS:-}" ]; then
    read -r -a docker_run_args <<<"${DOCKER_RUN_ARGS}"
    docker_cmd=(docker run --rm -i "${docker_run_args[@]}")
  else
    docker_cmd=(docker run --rm -i)
  fi

  require_cmd docker

  (
    cd "$loadtest_dir"
    "${docker_cmd[@]}" \
      -v "${loadtest_dir}:/src" -w /src \
      -e BASE_URL \
      -e INSECURE_SKIP_TLS_VERIFY \
      -e SCENARIO \
      -e VUS \
      -e DURATION \
      -e SLEEP \
      -e RATE \
      -e TIME_UNIT \
      -e PRE_ALLOCATED_VUS \
      -e MAX_VUS \
      -e BLOG_KEY \
      -e POST_URL \
      -e TAGS \
      -e BEHAVIOR_SCORE \
      -e HIGH_INTENT \
      -e ACCESS_TOKEN \
      -e STREAM_SECONDS \
      -e REQUEST_POOL_SIZE \
      -e TAGS_PER_REQUEST \
      -e HIGH_INTENT_RATIO \
      -e BEHAVIOR_SCORE_MIN \
      -e BEHAVIOR_SCORE_MAX \
      -e RANDOM_POOL_PICK \
      -e MUTATE_PER_REQUEST \
      -e QUERY_POOL \
      -e TAG_POOL \
      "${K6_IMAGE:-grafana/k6:latest}" run "${SCRIPT:-k6/http/rtb-decision.js}"
  )
}

run_k6_local() {
  local k6_bin="${K6:-k6}"
  require_cmd "$k6_bin"

  (
    cd "$loadtest_dir"
    "$k6_bin" run "${SCRIPT:-k6/http/rtb-decision.js}"
  )
}

run_reset

if [ "${RESET_ONLY:-false}" = "true" ]; then
  exit 0
fi

case "$mode" in
  docker)
    run_k6_docker
    ;;
  local)
    run_k6_local
    ;;
  *)
    printf 'unsupported mode: %s (expected: docker|local)\n' "$mode" >&2
    exit 1
    ;;
esac
