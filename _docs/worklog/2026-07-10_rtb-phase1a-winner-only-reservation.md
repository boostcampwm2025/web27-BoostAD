# RTB Phase 1A — Winner-only reservation 작업 기록

## 배경

before baseline에서 다음 병목이 확인됐다.

| cell | reserve reject | reserve avg | rollback avg |
|---|---:|---:|---:|
| fixed 30 | 19,697 | 1.76ms | 0.41ms |
| fixed 60 | 55,378 | 19.12ms | 2.69ms |
| random 30 | 834 | 93.65ms | 52.17ms |
| random 60 | 1,761 | 3,416ms | 3,066ms |

기존 경로는 top-K 10개를 병렬 예약하고, 성공 후보 중 winner를 고른 뒤 나머지를 rollback했다. Random 60에서는 reserve/rollback이 전체 latency를 지배했다.

## 설계 인과

이 섹션은 “예전엔 왜 후보 전체에 예약을 걸었는지”, “지금은 왜 1명만 예약해도 되는지”의 인과를 남긴다. 성능 수치보다 **예약 의미(동시성·순위·mutation 순서)** 가 핵심이다.

### 1. ANN·TopK 이전 — 유사도 통과 후보 전부 reserve

당시 matcher는 eligible 캠페인을 전부 돌며 `similarity >= 0.3`인 후보를 **개수 제한 없이** 반환했다. 그 직후 흐름은 다음과 같았다.

```text
match(유사도 필터) → reserve(후보 전체 incrementSpent) → score → select → rollback(패자)
```

전부 예약한 이유는 경매 품질이 아니라 **동시 요청에서의 예산 선점**이었다. 한 요청의 경매에 여러 후보가 들어가는데, 낙찰 전에 참가자 예산을 hold하지 않으면 이어지는 요청이 같은 예산을 보고 과다 낙찰할 수 있었다. 패자는 select 이후 `decrementSpent`로 되돌렸다.

이 시기 matcher의 `TOP_K=3`은 후보 개수 제한이 아니라, 캠페인 태그 유사도 스코어링용(top-3 태그 가중)이었다. 최종 경매 점수(`score` stage)는 reserve **이후**에 계산됐다.

관련: `_docs/technical-writing/02_rtb-reserve-rollback-bounded-fanout.md`

### 2. TopK window — reserve peak fan-out만 제한

다음 단계는 후보 집합을 새로 추리는 것이 아니라, 이미 match된 후보를 점수순으로 정렬한 뒤 `TOP_K=10` window씩 reserve하는 것이었다. 한 window에서 성공 후보가 나오면 멈추고, 그 window 안에서만 select·rollback했다.

즉 “전부 hold → 패자 환불” 구조는 유지한 채, 한 번에 Redis로 퍼지는 폭만 bounded화했다. hard cutoff(상위 10개만 보고 종료)는 상위가 예산 거절일 때 하위 낙찰 가능 후보를 놓치므로 window scan을 택했다.

### 3. ANN — 후보 축소(retrieval), 예약 정합성의 근거는 아님

ANN(`campaign-tag` HNSW)은 eligible 전체 순회 대신 top-M shortlist를 만들어 match 비용을 줄인다. 요청당 reserve window 상한(예: top-M=20 → 최대 2 window)에도 도움이 된다.

다만 ANN이 “이미 순위가 끝난 리스트”를 주므로 1등만 예약해도 된다로 해석하면 안 된다. ANN은 retrieval이다. 최종 낙찰 순위는 여전히 score / maxCpc / tie-break(`CampaignSelector`)가 정한다.

관련: `_docs/technical-writing/03_rtb-ann-campaign-tag-retrieval.md`

### 4. Winner-only — 순위 확정 후 1명만 atomic reserve

Phase 1A가 바꾼 핵심은 hold/rollback 폭이 아니라 **mutation 순서**다.

```text
match(후보) → select(순위 확정) → reserve(순위대로 예산 되는 첫 후보 1명만)
```

1명만 예약해도 되는 이유:

1. 누가 이길지는 Redis spent mutation **전에** 이미 확정된다.
2. 예약은 순위대로 Lua가 원자적으로 1명만 성공시킨다.
3. 패자는 예약을 하지 않으므로 rollback이 필요 없다.
4. 동시성은 “여러 명 hold 후 되돌리기”가 아니라 “한 명씩 atomic reserve”로 막는다.

정리하면, 예전 전체 예약은 **순위가 reserve 뒤에 있던 경매 모델**에서 동시성을 지키려는 선택이었고, winner-only는 **순위를 먼저 확정할 수 있게 된 뒤** hold/rollback 구조를 제거한 선택이다. ANN은 그 앞단 후보 수를 줄여 주는 개선이지, winner-only 정합성의 직접 근거는 아니다.

## 구현

### 1. 순위와 예산 mutation 분리

`CampaignSelector`로 score, maxCpc, tie-break 순위를 먼저 확정한다. winner-only 경로에서는 이 순서를 변경하지 않고 Redis에 전달한다.

```ts
const ranked = await selector.selectWinner(candidates);
const winner = await reserveFirstRankedCandidate(ranked.candidates);
```

### 2. Window 단위 winner-only Lua

후보를 10개씩 나눠 한 window를 하나의 Lua EVAL로 처리한다.

```text
KEYS = [campaign:rank1, ..., campaign:rank10]
ARGV = [cpc1, ..., cpc10]

for rank 1..10
  ACTIVE 확인
  RedisJSON의 최신 daily/total budget, spent 확인
  지불 가능하면 dailySpent/totalSpent 증가
  즉시 {rank, attemptedCount} 반환
end
```

첫 window에 예산 가능 후보가 없을 때만 다음 window Lua를 실행한다. 현재 ANN top-M=20이므로 요청당 최대 2회다.

### 3. Rollback 제거와 flag

- `winner_only`: reserved count 0 또는 1, rollback 후보 0
- `legacy_topk`: 기존 increment/selector/decrement 흐름 유지
- 알 수 없는 flag 값은 안전하게 `legacy_topk`로 fallback

local compose는 candidate 검증을 위해 winner-only가 기본이고, production compose는 명시적 전환 전까지 legacy가 기본이다.

### 4. 관측성

- `reserve_first_available` dependency operation 추가
- `reserveAttemptCandidateCount`: Lua가 실제 검사한 순위 수
- `reserveWindowAttemptCount`: 실제 EVAL window 수
- `reservedCandidateCount`: 0 또는 1
- `rollbackCandidateCount`: winner-only 성공 시 0
- reservation rejection counter는 Lua에서 winner 전에 탈락한 수만큼 증가
- loadtest manifest에 `budgetMode` 기록

## 테스트 결과

### 전체 회귀

```text
Test Suites: 10 passed, 10 total
Tests:       23 passed, 23 total
backend build: passed
changed-file ESLint: passed
```

추가된 주요 테스트:

- 최고 순위 후보만 예약
- 1순위 소진 시 2순위 예약 후 즉시 중단
- 전체 소진 business error와 rollback 미호출
- 10개 window당 repository 호출 1회
- 50개 동시 service 요청에서 budget 상한 유지
- legacy flag에서 기존 rollback 유지
- Lua 반환 index와 campaign ID 매핑

### 실제 Redis Lua 동시성

`dailyBudget=totalBudget=100`, `cpc=10`인 임시 RedisJSON 캠페인에 100개 EVAL을 동시에 실행했다.

```json
{
  "success": 10,
  "ordered": [2, 2],
  "aSpent": 100,
  "bSpent": 10,
  "overspent": false
}
```

- 정확히 10건만 성공
- spent는 100을 초과하지 않음
- 1순위가 소진된 2-key window에서 2순위 선택
- 검증용 Redis 키는 종료 후 삭제

### 실제 API smoke

reset 이후 `POST /api/sdk/decision`을 호출했다.

```text
status=success
reserveAttemptCandidateCount=1
reservedCandidateCount=1
rollbackCandidateCount=0
dependency operation=reserve_first_available, count=1
```

## 동작 변화와 주의사항

- winner-only 내부 `SelectionResult.candidates`는 실제 예산 mutation에 성공한 winner 1개만 포함한다. 따라서 bidlog queue에도 winner 항목만 생성된다.
- loser bid event가 제품 요구사항이라면 예산 mutation과 별개인 ranking-observation 이벤트로 다시 설계해야 한다. loser budget reservation을 복원해서 해결하면 안 된다.
- 다중-key Lua는 현재 단일 Redis 인스턴스에서는 원자적으로 동작한다. Redis Cluster 전환 시 campaign key hash tag 또는 별도 budget state key 설계가 필요하다.
- 이번 단계는 기존 `spent`를 reservation 용도로 계속 사용한다. view/click/TTL 상태 모델은 Phase 1B에서 분리해야 한다.

## After loadtest (paired)

- RUN_ID: `20260710-phase1a-after-164626`
- 상세: `_docs/worklog/2026-07-10_phase1a-after-harness.md`
- 첨부: `_docs/worklog/attachments/2026-07-10_phase1a-after-harness/20260710-phase1a-after-164626/`

| cell | success p95 (before→after) | drop | reserve avgMs | rollback |
|------|---------------------------:|-----:|--------------:|---------:|
| fixed 30 | 29→24ms | 0→0 | 1.76→1.10 | 0.41→0 |
| fixed 60 | 128→80ms | 17→8 | 19.1→3.12 | 2.69→0 |
| random 30 | 1534→1312ms | 22→9 | 93.7→30.2 | 52.2→0 |
| random 60 | 8487→7070ms | 1486→788 | 3416→580 | 3066→0 |

rollback은 전 cell 0. Random 60 cliff는 완화됐지만 p95는 여전히 초 단위라 matcher/hydrate 후속이 필요하다.

## 다음 작업

- Phase 1B: view/click/TTL 상태 모델 분리
- Phase 2: local campaign snapshot으로 RedisJSON hydrate 제거 후보 측정
