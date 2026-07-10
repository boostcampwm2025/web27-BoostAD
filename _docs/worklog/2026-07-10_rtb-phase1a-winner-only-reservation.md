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

## 다음 작업

동일한 Fixed/Random 30·60 × 60s suite를 `budgetMode=winner_only`로 실행해 before와 paired 비교한다. 이번 사용자 요청 범위에는 after 부하테스트를 포함하지 않는다.
