# RTB baseline 격리 의미 수정 및 ANN 재시작 안정화

## 결론

기존 loadtest reset은 각 cell 시작 전에 DB와 Redis의 `dailySpent`, `totalSpent`를 정상적으로 0으로 초기화하고 있었다. 기존 baseline에서 관찰된 reservation rejection은 이전 cell의 예산 상태가 유입된 것이 아니라, reset 이후 현재 cell의 60초 실행 중 동일 후보군에 요청이 집중되면서 발생한 budget pressure였다.

따라서 하네스에서 셀별 backend 재시작을 제거하고 reset API를 유일한 상태 격리 수단으로 사용한다. 분석 결과의 `budgetContaminated`도 `budgetPressureObserved`로 변경해 의미를 바로잡았다.

셀별 재시작을 시험하는 과정에서 발견한 별도 제품 결함도 함께 수정했다. backend 재시작 시 DB 캠페인을 Redis에 전체 저장하면서 기존 `embeddingTags`를 제거했고, 별도 embedding worker는 ML 모델 준비 전에 queue를 소비해 재생성 job을 실패시키고 있었다.

## 1. Baseline 하네스 수정

### 변경 전

```text
cell 시작
  -> backend restart (선택 옵션)
  -> reset API
  -> warm-up
  -> reset API
  -> k6 실행
```

backend restart는 spent 초기화에 필요하지 않으며 ANN cache lifecycle까지 변경해 성능 비교 조건을 불필요하게 확대했다.

### 변경 후

```text
cell 시작
  -> reset API (DB/Redis spent, 로그, 보조 키, bidlog queue 초기화)
  -> warm-up
  -> reset API (warm-up 상태 제거)
  -> k6 실행
```

- `RESTART_BACKEND_EACH_CELL` 경로를 제거했다.
- manifest에 `isolation: "reset-api"`를 기록한다.
- `budgetPressureObserved`는 현재 cell 안에서 reservation rejection이 1건 이상 발생했다는 의미로만 사용한다.
- `PRESSURE_OBSERVED_DURING_CELL`은 reset 실패나 cross-cell contamination을 뜻하지 않는다.

## 2. Backend 재시작 시 ANN embedding 보존

### 기존 원인

`CampaignService.loadAllCampaigns()`는 DB 캠페인을 `CachedCampaign`으로 변환할 때 `embeddingTags`를 포함하지 않았다. 이후 `saveCampaignCacheById()`가 Redis JSON root를 덮어쓰고 `syncCampaignTagVectorDocs()`를 호출하면서 캠페인의 기존 ANN 문서를 삭제했다.

### 수정 흐름

```text
DB campaign 조회
  -> 기존 Redis campaign 조회
  -> 현재 태그와 일치하고 384차원인 embedding만 병합
  -> 병합된 campaign cache 저장 및 ANN 문서 동기화
  -> 모든 태그 embedding이 있으면 queue 생략
  -> 누락된 경우에만 regeneration job enqueue
```

기존 failed job이 같은 job ID를 점유하고 있으면 failed job을 제거한 뒤 다시 enqueue한다. 대기·실행·지연 중인 job은 중복 생성하지 않는다.

## 3. Embedding worker readiness

worker를 다음과 같이 변경했다.

```ts
@Processor('embedding-queue', { autorun: false })
```

- worker 생성 직후에는 queue를 소비하지 않는다.
- `ml.model.ready` 이벤트가 발생하거나 application bootstrap 시 이미 모델이 준비된 경우에만 `worker.run()`을 호출한다.
- 중복 이벤트가 발생해도 worker는 한 번만 시작한다.

## 4. 검증 결과

### 정적·단위 검증

- `npm run build`: 통과
- 관련 Jest 4 suites, 10 tests: 통과
  - loadtest reset
  - ANN matcher
  - campaign initial cache loading
  - embedding worker lifecycle
- 변경 TS 파일 ESLint: 통과
- `run_rtb_suite.sh` shell syntax: 통과
- analyzer 재처리:
  - `budgetPressureObserved: true`
  - `budgetState: PRESSURE_OBSERVED_DURING_CELL`

### 실제 Docker 재시작 검증

```text
backend 재생성 전 ANN num_docs: 5439
backend 재생성 후 ANN num_docs: 5439
Campaign 초기 로딩: 1000개
초기 embedding queue: 0개
```

### Worker smoke 검증

기존 캠페인에 regeneration job 1건을 넣고 worker를 신규 부팅했다.

```text
Transformer 모델 로딩
-> ml.model.ready
-> Processing job worker-readiness-smoke
-> 임베딩 생성 완료
```

- 모델 준비 전 job 처리 오류: 0건
- 종료 후 embedding queue active/waiting/delayed/failed: 모두 0건
- 종료 후 ANN `num_docs`: 5439

## 5. 남은 사항

- stable-budget 테스트 fixture는 아직 구현하지 않았다. 현재 routine baseline은 in-run budget pressure를 명시적으로 관측해 결과와 함께 보고한다.
- worker 이미지에서 Xenova cache 디렉터리 생성 시 `EACCES` 경고가 발생하지만 이미지에 포함된 모델 파일로 로딩과 embedding 생성은 성공한다. cache 경로 권한 문제는 별도 운영 안정성 작업으로 분리할 수 있다.
- 기존 provisional baseline 원본은 변경하지 않는다. 기존 `budgetContaminated` 필드는 당시 analyzer 출력이며, 새 analyzer로 재처리할 때 새로운 라벨을 사용한다.
