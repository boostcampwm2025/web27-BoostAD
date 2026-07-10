# [WORKLOG] Phase 1A after harness (winner-only, reset-per-cell)

- Task 문서: ../tasks/2026-07-10_phase1a-after-harness.md
- 시작일: 2026-07-10
- 담당: Codex
- 작업 브랜치: `refactor/1000rpsCapable`
- 현재 상태: Done

---

## 진행 로그
### 2026-07-10

#### 작업 단위 1: after suite 실행 (winner-only)
- 한 일:
  - before와 동일 harness로 Fixed/Random × 30/60 × 60s 실행.
  - `BUDGET_MODE=winner_only`, ANN ON (`L=64`, `M=20`).
  - fixed_r30 직후 sampler `wait` hang → suite kill 후 teardown 수정, 동일 RUN_ID로 나머지 3 cell resume.
- 관찰/결과:
  - RUN_ID: `20260710-phase1a-after-164626`
  - rollback stage count = 0 (전 cell)
  - Random 60: drop 1486→788, reserve avgMs 3416→580, success p95 8487→7070ms
  - Fixed 60: biz success ~49% 유지(budget pressure), success p95 128→80ms, reserve avgMs 19→3.1
- 다음 액션:
  - Phase 1B(view/click/TTL 상태 분리) 또는 Phase 2(local snapshot)로 Random cliff 잔여 병목 공략
- 변경 사항(코드/명령):
```bash
# sampler hang fix in run_rtb_suite.sh: TERM → poll → KILL before wait

LOADTEST_RESET_TOKEN=boostad-loadtest-reset-local \
BASE_URL=http://127.0.0.1:3000 \
VARIANT_LABEL=after \
DURATION=60s \
MATRIX='fixed:30 fixed:60 random:30 random:60' \
RUN_ID=20260710-phase1a-after-164626 \
OUTPUT_DIR=.loadtest/results/20260710-phase1a-after-164626 \
./scripts/run_rtb_suite.sh
```

#### 의사결정(Decision)
- 결정 내용:
  - hang으로 끊긴 fixed_r30을 버리고 전체 재실행하지 않고, 동일 RUN_ID에 나머지 cell을 이어 붙였다.
- 이유:
  - fixed_r30 analysis/onset이 이미 완료됐고, cell isolation은 reset API라 순서 의존성이 없다.
- 영향/리스크:
  - manifest는 resume 시 matrix가 일시적으로 3 cell로 덮였다가 문서화 시 4 cell로 복구했다.

#### 메모/컨텍스트
- reservedCandidates avg ≈ biz success rate에 근접(0~1). rollbackCandidates avg = 0.
- Fixed reject 수는 before와 거의 동일 → winner-only는 reject 카운트(순위 스캔 탈락)를 없애지 않고, parallel reserve/rollback 비용을 없앤다.

## 결과 표 (after)

| cell | iters | drop | biz success | success p95 | success p99 | reserve reject | reserve avgMs | rollback | onset |
|------|------:|-----:|------------:|------------:|------------:|---------------:|--------------:|---------:|------:|
| fixed/30 | 1801 | 0 | 98.3% | 24ms | 60ms | 19697 | 1.10 | 0 | 2.2s |
| fixed/60 | 3593 | 8 | 49.3% | 80ms | 937ms | 55500 | 3.12 | 0 | 1.1s |
| random/30 | 1792 | 9 | 92.2% | 1312ms | 2026ms | 561 | 30.2 | 0 | 18.6s |
| random/60 | 2813 | 788 | 91.9% | 7070ms | 7871ms | 2270 | 580 | 0 | 14.0s |

## before → after 비교

| cell | success p95 | drop | reserve avgMs | rollback avgMs |
|------|------------:|-----:|--------------:|---------------:|
| fixed/30 | 29→24ms | 0→0 | 1.76→1.10 | 0.41→0 |
| fixed/60 | 128→80ms | 17→8 | 19.1→3.12 | 2.69→0 |
| random/30 | 1534→1312ms | 22→9 | 93.7→30.2 | 52.2→0 |
| random/60 | 8487→7070ms | 1486→788 | 3416→580 | 3066→0 |

## 원본 위치
- `.loadtest/results/20260710-phase1a-after-164626/`
- `_docs/worklog/attachments/2026-07-10_phase1a-after-harness/20260710-phase1a-after-164626/`

## 현재 이슈/블로커
- Random 60은 여전히 VU 고갈/초 단위 p95. reserve 병목은 줄었지만 matcher/hydrate 쪽이 남음.
- Fixed 60 budget contamination은 Phase 1A 범위 밖.

## 다음 작업 체크리스트(현 시점)
- [ ] Phase 2 local campaign snapshot 후보 설계/측정
- [ ] Fixed용 stable-budget fixture 여부 결정
- [ ] sampler teardown 수정 커밋 여부 결정
