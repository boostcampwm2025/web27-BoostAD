# [TASK] Phase 1A after harness (winner-only, reset-per-cell)

## 0. 메타
- ID: T-2026-07-10-PHASE1A-AFTER-HARNESS
- 작성일: 2026-07-10
- 작성자: Codex
- 작업 브랜치: `refactor/1000rpsCapable`
- 상태: Done
- 관련 링크:
  - `_docs/worklog/2026-07-10_phase1a-after-harness.md`
  - `_docs/worklog/2026-07-10_rtb-phase1a-winner-only-reservation.md`
  - `_docs/worklog/attachments/2026-07-10_phase1a-after-harness/20260710-phase1a-after-164626/`
  - before: `_docs/worklog/attachments/2026-07-10_before-baseline-harness/20260710-before-baseline-160102/`
- 영향 범위: loadtest 측정/문서. 제품 코드 변경 없음( suite sampler teardown 수정만 ).

## 1. 문제 정의
- Phase 1A(winner-only reservation) 구현 후, before baseline과 동일 4 cell로 paired after가 필요했다.

## 2. 실행 계약
- variant: `after` (`RTB_BUDGET_MODE=winner_only`, ANN ON L=64 M=20)
- isolation: reset API only (`restartBackendEachCell=false`)
- corpus: deterministic 3600 rows, seed `20260710`
- evidence: `PROVISIONAL` (1회)
- paired before: `20260710-before-baseline-160102`

## 3. 결과 요약
| cell | iters | drop | business success | success p95 | reservationRejected | pressure onset |
|------|------:|-----:|-----------------:|------------:|--------------------:|---------------:|
| fixed 30 | 1801 | 0 | 98.3% | 24.0ms | 19697 | 2.2s |
| fixed 60 | 3593 | 8 | 49.3% | 80.4ms | 55500 | 1.1s |
| random 30 | 1792 | 9 | 92.2% | 1312ms | 561 | 18.6s |
| random 60 | 2813 | 788 | 91.9% | 7070ms | 2270 | 14.0s |

### before 대비 핵심 변화
| cell | success p95 (before→after) | drop (before→after) | reserve avgMs (before→after) | rollback avgMs |
|------|---------------------------:|--------------------:|-----------------------------:|---------------:|
| fixed 30 | 29→24ms | 0→0 | 1.76→1.10 | 0.41→none |
| fixed 60 | 128→80ms | 17→8 | 19.1→3.12 | 2.69→none |
| random 30 | 1534→1312ms | 22→9 | 93.7→30.2 | 52.2→none |
| random 60 | 8487→7070ms | 1486→788 | 3416→580 | 3066→none |

## 4. 해석
- rollback stage는 전 cell에서 0. winner-only fanout `reservedCandidates.avg ≈ 0~1`, `rollbackCandidates.avg = 0`.
- Random 60 cliff는 완화(drop 1486→788, reserve avg 3.4s→0.58s)됐지만 success p95는 여전히 초 단위. matcher/hydrate 병목이 남는다.
- Fixed 60 business success ~49%는 before와 동일 계열. decision-only spent 누적에 의한 `PRESSURE_OBSERVED_DURING_CELL`이며 Phase 1A로 해소되지 않는다.

## 5. DoD
- [x] 4 cell 실행
- [x] raw metrics/k6/analysis 저장
- [x] budget pressure onset + timeseries 저장
- [x] before paired 비교 표 작성
- [x] Worklog 작성
