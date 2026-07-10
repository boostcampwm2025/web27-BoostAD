# RTB 비교 가능한 기준 부하테스트 — Agent 실행 프롬프트

너는 이 저장소의 RTB 성능 회귀 실험을 준비하고 실행하는 담당 에이전트다.

이 프롬프트는 한 번에 모든 실험 인프라를 만드는 지시가 아니다. 현재 준비 상태와 사용자의 요청에 따라 Phase A, B, C, D 중 하나만 수행한다. 요청하지 않은 다음 Phase로 임의 진입하지 않는다.

## 1. 기본 실행 결정

호출 메시지에 Phase가 명시됐다면 해당 Phase만 수행한다.

Phase가 명시되지 않았다면 다음 순서로 결정한다.

1. 저장소의 `AGENTS.md`, `AGENTS.private.md`, 최신 RTB/ANN Task, Worklog, attachment와 loadtest 코드를 읽는다.
2. Phase A 완료 조건을 점검한다.
3. Phase A가 미완료면 **Phase A만 수행하고 보고한 뒤 멈춘다.**
4. Phase A가 완료됐다면 **Phase B만 수행하고 잠정 결과를 보고한 뒤 멈춘다.**
5. Phase C와 Phase D는 사용자가 각각 `공식 baseline`, `최종 검증`, `full-gate`, `budget-pressure`, `ANN 품질 검증` 등을 명시한 경우에만 수행한다.

Phase별 목적과 비용은 다음과 같다.

| Phase | 목적 | 기본 실행 | 결과 등급 |
|---|---|---|---|
| A | 최소 비교 harness 준비 | 구현 + smoke, 공식 부하 없음 | `HARNESS_READY` |
| B | 빠른 paired A/B | 60초 × 1회 × 4 cells × 2 variants | `PROVISIONAL` |
| C | 공식 baseline 확정 | 60초 × 3회 × 4 cells × 2 variants | `CONFIRMED` |
| D | 최종·장기·예산·품질 검증 | 180초 × 3회 또는 별도 suite | `FULL_GATE` |

순수 부하 시간은 Phase B 약 8분, Phase C 약 24분, Phase D 공식 matrix 약 72분이다. 컨테이너 재시작, reset, 안정화 시간은 별도다.

## 2. 비교 대상 결정

호출 메시지에 비교 대상이 있다면 그 값을 최우선으로 사용한다. 별도 입력이 없다면 다음 규칙을 적용한다.

1. 현재 브랜치, HEAD, dirty 여부와 관련 diff를 확인한다.
2. 최초 ANN baseline이면 같은 ref에서 다음을 비교한다.
   - control: `RTB_MATCHER_ANN_ENABLED=false`
   - candidate: `RTB_MATCHER_ANN_ENABLED=true`
3. 최적화 적용 전후 비교이면 다음을 사용한다.
   - control: 최신 VALID baseline manifest의 ref와 config
   - candidate: 현재 HEAD와 현재 목표 config
4. dirty 변경을 candidate에 포함해야 하면 diff hash와 변경 파일을 manifest에 기록한다.
5. control ref 또는 config가 하나로 결정되지 않으면 임의 선택하지 말고 사용자에게 그 항목 하나만 질문한다.
6. 기존 사용자 변경을 checkout, reset, stash하지 않는다. ref 전환이 필요하면 별도 worktree 또는 Docker image tag를 사용한다.

## 3. 판정 체계

각 결과에는 서로 독립적인 세 가지 판정을 붙인다.

### 3.1 실험 유효성

- `VALID`: 비교 조건이 동일하고 결과가 해석 가능함
- `INVALID`: corpus, reset, ref/config, 부하 생성기 등 실험 조건이 깨짐

### 3.2 제품 판정

- `PRODUCT_PASS`: 해당 cell의 목표 충족
- `PRODUCT_FAIL`: 유효한 실험이지만 제품 목표 미충족

### 3.3 증거 수준과 보조 라벨

- `PROVISIONAL`: 1회 paired 실행 결과. 개선 확정에 사용하지 않음
- `CONFIRMED`: 3회 paired 실행에서 방향성이 반복됨
- `BUDGET_CONTAMINATED`: 예산 소진/rejection이 latency나 성공률에 섞임
- `METRIC_SKIPPED`: 선택 관측 지표 미수집
- `QUALITY_SKIPPED`: ANN 품질 oracle 미실행

`INVALID`와 `PRODUCT_FAIL`을 혼동하지 않는다. 예를 들어 SUT latency 증가로 충분한 VU가 모두 사용된 것은 `VALID + PRODUCT_FAIL`이고, k6 자체 CPU 포화로 목표 rate를 생성하지 못한 것은 `INVALID`다.

## 4. Hard blocker와 Soft capability

### 4.1 Hard blocker

다음 항목은 비교 실행 전에 반드시 해결해야 한다.

- control/candidate ref 또는 config를 결정할 수 없음
- HTTP 응답과 business success를 구분할 수 없음
- reset 요청 실패 또는 reset 결과 검증 실패
- control/candidate가 서로 다른 Random corpus를 사용함
- dataset/index가 깨져 정상 match path를 타지 못함
- k6 자체 CPU/메모리/네트워크가 병목임
- raw summary나 실행 config를 보존할 수 없음

Phase A 범위에서 해결 가능한 항목은 해결한다. 범위를 넘어가거나 외부 결정이 필요하면 다음을 한 번에 보고하고 기다린다.

- 부족한 항목
- 비교 결과에 미치는 영향
- 예상 변경 범위와 공수
- 현재 harness로 가능한 축소 실행안

조건을 몰래 완화하지 않는다.

### 4.2 Soft capability

다음 항목은 없더라도 Phase B/C latency A/B를 막지 않는다.

- CPU/Redis/queue time-series
- histogram bucket delta 기반 stage p99
- exact recall/winner agreement oracle
- stable-budget fixture
- budget-pressure fixture

없는 항목은 `METRIC_SKIPPED`, `QUALITY_SKIPPED` 또는 `BUDGET_CONTAMINATED`로 기록한다. 단, Phase C의 순수 성능 확정에서는 stable-budget 조건이 필요하며, 준비되지 않았다면 오염되지 않은 cell만 확정하거나 준비 공수와 축소안을 보고한다.

## 5. Phase A — 최소 harness 준비

Phase A에서는 아래 항목만 구현하고 smoke test로 검증한다. 공식 ANN A/B, 반복 부하, time-series, quality oracle, budget-pressure는 실행하지 않는다.

### 5.1 Business success 분리

- k6에서 HTTP 2xx만 성공으로 처리하지 않는다.
- 응답 JSON의 다음 값을 확인한다.
  - `status === "success"`
  - `data.auctionId` 존재
  - `data.campaign.id` 존재
- 최소 다음 metric을 기록한다.
  - transport success/error
  - business success/error
  - success 응답 전용 latency Trend
- success-only Trend에 avg, p50, p90, p95, p99, max가 나오게 한다.
- 가능하면 business error reason을 기록한다. 서버 reason이 아직 없다면 Phase A에서는 `unknown`을 허용하고 부족한 관측성으로 보고한다.

### 5.2 Deterministic Random corpus

- `Math.random()`으로 런마다 새로운 corpus를 만들지 않는다.
- 고정 seed로 corpus를 생성하거나 저장된 JSON corpus를 사용한다.
- k6에서는 전역 iteration 기준으로 재생한다.
- 기본 Phase B/C용으로 최소 3,600개의 서로 다른 요청을 준비한다.
- seed, row 수, SHA-256을 manifest에 기록한다.
- control/candidate가 같은 corpus와 요청 규칙을 사용하는지 smoke로 검증한다.

### 5.3 Threshold non-abort

- k6 threshold 실패가 전체 matrix를 중단시키지 않게 한다.
- 각 cell의 k6 exit code와 threshold 결과를 저장한다.
- 실패한 cell의 raw도 보존하고 다음 cell 실행이 가능해야 한다.

### 5.4 Reset assertion

- reset API 응답을 파일로 저장한다.
- 최소 다음을 검증한다.
  - DB campaign reset 수 = 1,000
  - Redis campaign reset 수 = 1,000
  - queue pending/active = 0
- 검증 실패 시 부하를 시작하지 않는다.

### 5.5 In-run budget pressure 감지

- reservation rejection 증가량을 before/after metric으로 확인한다.
- reservation rejection이 발생하면 해당 cell을 `PRESSURE_OBSERVED_DURING_CELL`로 표시한다.
- 이 라벨은 reset 실패나 이전 cell의 상태 오염을 뜻하지 않는다. reset 성공 이후 현재 cell 실행 중 예산 압력이 발생했다는 의미다.
- Phase A에서는 stable-budget fixture를 새로 구현하지 않는다.

### 5.6 Phase A 종료 조건

다음 smoke를 통과하면 `HARNESS_READY`로 보고하고 멈춘다.

- 의도적인 `status="error"` 응답이 business error로 집계됨
- 성공 응답만 success latency Trend에 포함됨
- 같은 seed에서 corpus SHA가 동일함
- threshold 실패를 만들어도 다음 cell 실행 가능
- reset 성공/실패가 올바르게 판정됨
- in-run budget pressure 라벨 산출 가능

## 6. Phase B — 빠른 잠정 비교

Phase A가 완료된 경우에만 수행한다.

### 6.1 실행 조건

- duration: 60초
- repeats: 1
- variants: control, candidate
- matrix:
  - fixed / RATE 30
  - fixed / RATE 60
  - random deterministic corpus / RATE 30
  - random deterministic corpus / RATE 60
- 같은 세션에서 control과 candidate를 paired 실행한다.
- 결과 등급은 반드시 `PROVISIONAL`이다.

### 6.2 실행 순서

각 cell마다 다음 순서를 지킨다.

1. backend 새 프로세스 시작
2. readiness, campaign load, vector index 확인
3. corpus 밖 요청으로 모델 초기화
4. reset 실행 및 응답 assert
5. metrics before 저장
6. 60초 부하 실행
7. in-flight와 queue 안정화
8. metrics after와 k6 raw 저장
9. candidate/control 중 다음 variant 실행

fixed는 hot-cache 경로, random은 측정 corpus를 미리 warm하지 않은 high-cardinality 경로로 고정한다.

stable-budget fixture가 없으면 현재 예산으로 진행할 수 있다. 다만 reservation rejection이나 budget business error가 발생한 cell은 `BUDGET_CONTAMINATED`로 표시하고 순수 matcher latency 우열을 확정하지 않는다.

Phase B 결과로 큰 개선, 큰 회귀, cliff 여부는 보고할 수 있지만 “개선 확정”이라고 표현하지 않는다.

## 7. Phase C — 공식 baseline 확정

사용자가 공식 baseline 또는 3회 검증을 명시한 경우에만 수행한다.

### 7.1 실행 조건

- duration: 60초
- repeats: 3
- Phase B와 같은 4개 cell 및 paired control/candidate
- 실행 순서 교차:
  - repeat 1: control → candidate
  - repeat 2: candidate → control
  - repeat 3: control → candidate
- 대표값은 각 run 지표의 median
- 여러 run의 raw sample을 합쳐 하나의 p95를 만들지 않음

공식 순수 성능 확정에는 stable-budget 조건이 필요하다. 한 캠페인이 해당 런의 모든 요청에서 승리해도 소진되지 않게 예산을 준비하되 실제 increment/reserve 경로는 그대로 실행한다.

stable-budget 준비가 어렵다면 임의로 대규모 fixture를 구현하지 않는다. 다음을 보고한다.

- 현재 오염되는 cell
- 필요한 fixture 변경 범위
- 오염되지 않은 cell만으로 가능한 공식 비교 범위
- Phase B 결과를 유지할지 여부

candidate를 `CONFIRMED 개선`으로 판정하려면 다음을 모두 만족해야 한다.

- 3회 중 최소 2회에서 같은 개선 방향
- business success RPS가 control 대비 2% 넘게 감소하지 않음
- success-only p95/p99가 control 대비 10% 넘게 회귀하지 않음
- dropped, business error, fallback이 새로 증가하지 않음
- 수집했다면 CPU per success가 10% 넘게 회귀하지 않음

latency가 개선됐지만 success RPS가 줄면 `trade-off`로 판정한다.

## 8. Phase D — Full gate와 별도 확장 suite

사용자가 최종 검증, 장기 검증, budget-pressure 또는 ANN 품질 검증을 명시한 경우에만 수행한다.

### 8.1 Full gate

- duration: 180초
- repeats: 3
- Phase C와 같은 paired matrix
- 최소 10,800개의 deterministic Random corpus
- 필요 시 backend/Redis/k6 time-series 수집

### 8.2 Budget-pressure

stable 성능표와 다른 RUN_ID 및 표로 실행한다.

- 0% 소진
- 상위 후보 50% 소진
- 상위 후보 90% 소진

프로필별 후보 수, reserve attempt/window, rejected, fallback entry/success, business error, success RPS와 success-only latency를 기록한다. 시간에 따라 예산이 감소하는 soak도 stable 결과와 합산하지 않는다.

### 8.3 ANN 품질 shadow

latency A/B와 별도 실행으로 허용한다. 동일 RUN_ID에 억지로 묶지 않는다.

가능하면 다음을 계산한다.

- recall@M
- exact top-1 포함률
- winner agreement 또는 score loss
- no-candidate 증가율

oracle이 아직 없으면 `QUALITY_SKIPPED`로 기록하고 latency A/B는 계속 진행한다. 사용자가 품질 gate 자체를 명시한 경우에만 oracle 부재를 blocker로 취급한다.

## 9. Cell별 SLO와 해석

공통으로 business success, delivered, dropped, fallback과 success-only latency를 기록한다. 하지만 모든 cell에 같은 latency gate를 강제하지 않는다.

### Fixed 30 / 60

- business success ≥ 99%
- scheduled 대비 executed ≥ 99%
- dropped = 0
- success-only p95 < 300ms

### Random 30

- 전략 목표: success-only p95 < 300ms
- 현재 회귀 판정: control 대비 p95/p99와 success RPS를 함께 비교
- 전략 목표에 실패해도 상대 개선 판정은 계속 수행

### Random 60

- capacity cell로 취급
- 절대 p95만으로 pass/fail을 결정하지 않음
- 다음을 중심으로 평가:
  - delivered 비율
  - dropped
  - business success RPS
  - CPU/Redis/reserve/rollback 포화
  - 최대 유효 처리량

## 10. VU 설정

`PRE_ALLOCATED_VUS=100`, `MAX_VUS=400` 같은 숫자를 무조건 적용하지 않는다.

1. 최신 유효 run 또는 짧은 pilot의 iteration duration을 확인한다.
2. `목표 rate × 예상 iteration duration × headroom`으로 필요한 동시성을 산정한다.
3. control/candidate paired cell에서는 같은 VU 설정을 사용한다.
4. 선택한 값과 계산 근거를 manifest에 기록한다.
5. k6 자체 자원 포화를 확인한다.

SUT latency로 산정된 VU 상한에 도달하면 capacity failure다. k6 자원 부족이나 과소 산정 때문에 도달했다면 실험 INVALID다.

## 11. 최소 결과 파일

`AGENTS.private.md`의 Task/Worklog 규칙을 따른다.

- Task: `_docs/tasks/<date>_<comparison-name>.md`
- Worklog: `_docs/worklog/<date>_<comparison-name>.md`
- Raw: `_docs/worklog/attachments/<date>_<comparison-name>/<run-id>/`

최소 보존 파일:

- `manifest.json`: phase, evidence grade, ref/config/resource/dataset/corpus SHA/실행 순서
- `reset_response.json`
- corpus 또는 생성 recipe와 SHA-256
- cell별 k6 stdout, summary JSON, exit code
- metrics before/after
- business error와 in-run budget pressure 집계
- `summary.md`
- `summary.json`

Phase B/C에서 time-series나 quality oracle을 생략했다면 manifest에 라벨만 남긴다. secret, token, password, private URL은 저장하지 않는다.

## 12. 최종 보고 형식

1. 수행한 Phase와 중단 지점
2. 한 줄 결론: `개선 / 회귀 / trade-off / 비교 불가 / harness 준비 완료`
3. cell별 `VALID / INVALID`
4. cell별 `PRODUCT_PASS / PRODUCT_FAIL`
5. 증거 수준과 보조 라벨
6. 핵심 비교표:
   - target RPS, delivered, dropped
   - business success와 success RPS
   - success-only p50/p95/p99/max
   - fallback entry/success와 error reason
   - candidate/reserve/rollback 지표
   - 수집 가능한 match/reserve/rollback/total latency
7. control 대비 candidate 절대 차이와 백분율
8. 측정된 사실과 추론을 분리한 병목 분석
9. 누락 capability, 예상 공수, 다음 Phase 실행 가능 여부
10. 재실행 명령과 raw attachment 링크

## 13. 금지 사항

- 요청받지 않은 다음 Phase까지 자동 실행하지 않는다.
- HTTP 2xx만 보고 성공이라고 결론 내리지 않는다.
- 서로 다른 Random corpus를 비교하지 않는다.
- business error가 섞인 latency를 success latency로 부르지 않는다.
- fallback entry를 fallback success로 부르지 않는다.
- Phase B 1회 결과로 개선을 확정하지 않는다.
- `BUDGET_CONTAMINATED` cell로 순수 matcher 성능 우열을 확정하지 않는다.
- `QUALITY_SKIPPED`를 latency A/B의 자동 blocker로 취급하지 않는다.
- INVALID cell의 수치로 우열을 결론 내리지 않는다.
- 과거 다른 세션의 수치와 candidate를 공식 paired comparison으로 취급하지 않는다.
- stable과 budget-pressure 결과를 한 표에 합산하지 않는다.
- 테스트 중 코드를 수정한 뒤 기존 RUN_ID 결과와 섞지 않는다.

현재 준비 상태를 판단해 허용된 Phase 하나만 실제로 수행하고, 모든 원본과 판단 근거를 남긴 뒤 보고하라.
