# RTB Phase 1A — Winner-only reservation

## 목표

기존 `top-K 예약 → winner 선택 → loser rollback` 구조를 feature flag 뒤의 winner-only 경로로 대체한다.

```text
후보 전체 순위 확정
→ 상위 10개 window를 Redis Lua 1회로 검사
→ 순위가 가장 높은 예산 가능 후보 1개만 Spent 증가
→ winner 반환
→ loser rollback 없음
```

## 범위

- `RTB_BUDGET_MODE=winner_only` 구현
- `legacy_topk` 긴급 롤백 경로 유지
- 10개 window 단위 다중-key Lua 원자 예약
- 현재 RedisJSON의 status/budget/spent를 Lua 실행 시점에 검사
- winner-only 경로의 reserved 후보 수를 최대 1로 제한
- loser decrement 호출 제거
- fan-out/dependency/budget pressure 지표 유지
- 단위 테스트, 50개 service 동시 요청 테스트, 실제 Redis Lua 100개 동시 실행 검증

## 비범위

이번 작업은 roadmap 전체 Phase 1 중 reserve/rollback fan-out 제거에 해당한다. 다음 항목은 후속 Phase 1B 범위다.

- `dailyReserved`, `totalReserved`와 committed spent 분리
- auctionId 기반 decision 멱등성
- RESERVED → VIEWED → COMMITTED/RELEASED 상태 머신
- no-view TTL release와 유실 복구
- dismiss/click 동시성 규칙
- Redis Cluster hash-slot 대응

## 완료 조건

- [x] 첫 예산 가능 후보 1개만 증가
- [x] 정상 winner-only 요청의 rollback count 0
- [x] 후보 10개당 Redis Lua 최대 1회
- [x] 모든 후보 소진 시 business error
- [x] concurrent reservation에서 budget 초과 없음
- [x] `legacy_topk` rollback flag 유지
- [x] 전체 backend 테스트 통과
- [x] 실제 RedisJSON/Lua smoke 통과

## Rollout

- 로컬 compose 기본값: `winner_only`
- 프로덕션 compose 기본값: `legacy_topk`
- candidate 검증 후 운영에서 명시적으로 `RTB_BUDGET_MODE=winner_only` 설정
