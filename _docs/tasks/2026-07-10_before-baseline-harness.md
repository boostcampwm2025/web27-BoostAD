# [TASK] 수정 하네스 before baseline (ANN ON, reset-per-cell)

## 0. 메타
- ID: T-2026-07-10-BEFORE-BASELINE-HARNESS
- 작성일: 2026-07-10
- 작성자: Codex
- 작업 브랜치: `refactor/1000rpsCapable`
- 상태: Done
- 관련 링크:
  - `_docs/worklog/2026-07-10_before-baseline-harness.md`
  - `_docs/worklog/attachments/2026-07-10_before-baseline-harness/20260710-before-baseline-160102/`
  - `.loadtest/scripts/run_rtb_suite.sh`
- 영향 범위: loadtest harness 실행/측정. 제품 코드 변경 없음( suite에 budget pressure sampler 추가 ).

## 1. 문제 정의
- 수정된 harness로 comparable before baseline이 필요했다.
- 조건: backend 재시작 없이 cell마다 reset, Fixed/Random × 30/60, 각 60s, 원본 지표 + budget pressure 시점 저장.

## 2. 실행 계약
- variant: `before` (ANN ON, L=64, M=20)
- isolation: reset API only (`restartBackendEachCell=false`)
- corpus: deterministic 3600 rows, seed `20260710`
- evidence: `PROVISIONAL` (1회)

## 3. 결과 요약
| cell | iters | drop | business success | success p95 | reservationRejected | pressure onset |
|------|------:|-----:|-----------------:|------------:|--------------------:|---------------:|
| fixed 30 | 1800 | 0 | 98.4% | 29.1ms | 19697 | 2.2s |
| fixed 60 | 3584 | 17 | 49.4% | 127.7ms | 55378 | 1.1s |
| random 30 | 1779 | 22 | 92.2% | 1534ms | 834 | 18.8s |
| random 60 | 2114 | 1486 | 92.0% | 8487ms | 1761 | 10.1s |

## 4. 해석
- Fixed는 latency는 낮지만 decision-only spent 누적으로 현재 cell 실행 중 reservation reject와 business error가 빠르게 발생한다. 이는 reset 실패가 아니라 `PRESSURE_OBSERVED_DURING_CELL`이다.
- Random 60은 reserve/rollback cliff.
- 이 baseline은 이후 최적화 candidate와 same-session paired 비교용 before 스냅샷이다.

## 5. DoD
- [x] 4 cell 실행
- [x] raw metrics/k6/analysis 저장
- [x] budget pressure onset + timeseries 저장
- [x] Worklog 작성
