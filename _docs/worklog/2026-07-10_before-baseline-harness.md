# [WORKLOG] 수정 하네스 before baseline (ANN ON, reset-per-cell)

- Task 문서: ../tasks/2026-07-10_before-baseline-harness.md
- 시작일: 2026-07-10
- 담당: Codex
- 작업 브랜치: `refactor/1000rpsCapable`
- 현재 상태: Done

---

## 진행 로그
### 2026-07-10

#### 작업 단위 1: before baseline suite 실행
- 한 일:
  - 수정 harness(`.loadtest/scripts/run_rtb_suite.sh`)로 before baseline 실행.
  - backend 재시작 없이 cell마다 reset → warmup → reset → measure.
  - matrix: fixed 30/60, random 30/60, duration 60s.
  - cell 중 metrics 1s 샘플링으로 `budget_pressure_onset.json` / `metrics_timeseries.ndjson` 저장.
- 관찰/결과:
  - RUN_ID: `20260710-before-baseline-160102`
  - ANN ON (`L=64`, `M=20`)
  - 모든 cell에서 reservation reject 발생 (`PRESSURE_OBSERVED_DURING_CELL`)
  - Fixed 60은 business success 49.4%로 in-run budget pressure가 큼
  - Random 60은 drop 1486, success p95 ≈ 8.5s (cliff)
- 다음 액션:
  - 동일 harness로 candidate/after 비교 시 same-session paired 실행
  - Fixed cell은 stable-budget fixture 없이는 pure matcher latency 확정에 사용하지 않음
- 변경 사항(코드/명령):
```bash
LOADTEST_RESET_TOKEN=... \
BASE_URL=http://127.0.0.1:3000 \
VARIANT_LABEL=before \
DURATION=60s \
MATRIX='fixed:30 fixed:60 random:30 random:60' \
RUN_ID=20260710-before-baseline-160102 \
OUTPUT_DIR=.loadtest/results/20260710-before-baseline-160102 \
./scripts/run_rtb_suite.sh
```

#### 의사결정(Decision)
- 결정 내용:
  - before baseline은 ANN ON 현재 상태를 기준으로 기록한다.
  - cell isolation은 backend recreate가 아니라 reset API만 사용한다.
- 이유:
  - 사용자 요청 조건과 수정 harness lifecycle(`restartBackendEachCell:false`)에 맞춘다.
- 영향/리스크:
  - Prometheus counter는 프로세스 누적이라 onset baseline은 cell 시작 snapshot 대비 delta로 해석해야 한다.
  - decision-only는 spent를 소모하므로 Fixed high-rate는 빠르게 budget pressure에 들어간다.

## 결과 표

| cell | iters | drop | biz success | success p95 | success p99 | server error | reserve reject | onset |
|------|------:|-----:|------------:|------------:|------------:|-------------:|---------------:|------:|
| fixed/30 | 1800 | 0 | 98.4% | 29ms | 96ms | 29 | 19697 | 2.2s |
| fixed/60 | 3584 | 17 | 49.4% | 128ms | 307ms | 1813 | 55378 | 1.1s |
| random/30 | 1779 | 22 | 92.2% | 1534ms | 2684ms | 138 | 834 | 18.8s |
| random/60 | 2114 | 1486 | 92.0% | 8487ms | 8690ms | 169 | 1761 | 10.1s |

## 원본 위치
- `.loadtest/results/20260710-before-baseline-160102/`
- `_docs/worklog/attachments/2026-07-10_before-baseline-harness/20260710-before-baseline-160102/`
- cell별 파일:
  - `k6_summary.json`, `k6_stdout.txt`
  - `metrics_before.txt`, `metrics_after.txt`
  - `metrics_timeseries.ndjson`
  - `budget_pressure_onset.json`
  - `analysis.json`
  - `reset_response.json`

## 현재 이슈/블로커
- Fixed 60은 현재 cell 안의 budget pressure가 커서 pure latency before로 쓰기 어렵다.
- Random 60 cliff는 reserve/rollback 지배.

## 다음 작업 체크리스트
- [x] candidate 변경 후 동일 suite로 paired after 실행 → `_docs/worklog/2026-07-10_phase1a-after-harness.md`
- [ ] Fixed용 stable-budget fixture 여부 결정
- [ ] onset/timeseries를 analysis schema에 정식 필드로 고정
