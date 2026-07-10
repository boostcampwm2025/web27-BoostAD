# Loadtest (k6)

이 디렉토리는 **BoostAD 백엔드 부하 테스트 스크립트**를 모아두는 곳입니다.

## 빠른 시작

1) 환경 변수 설정

```bash
cd loadtest
cp .env.example .env
set -a; source .env; set +a
```

2) k6 실행 (Docker 권장)

```bash
make k6 SCRIPT=k6/http/rtb-decision.js
```

3) 상태 초기화 후 k6 실행

```bash
make k6-reset SCRIPT=k6/http/rtb-decision.js
```

로컬 `k6` 바이너리를 직접 쓰면:

```bash
make k6-local-reset SCRIPT=k6/http/rtb-decision.js
```

## 타겟 URL

- `make k6`는 **Docker 컨테이너 안에서** 실행됩니다. 따라서 `BASE_URL`은 “컨테이너에서 접근 가능한 주소”여야 합니다.

### 로컬

- Docker Desktop (Mac/Windows)에서 호스트로 접근:
    - 백엔드 직접: `BASE_URL=http://host.docker.internal:3000`
    - nginx 경유(HTTPS): `BASE_URL=https://host.docker.internal`
- Linux에서 호스트로 접근(둘 중 1개 선택):
    - `DOCKER_RUN_ARGS="--network host"` + `BASE_URL=http://127.0.0.1:3000`
    - `DOCKER_RUN_ARGS="--add-host=host.docker.internal:host-gateway"` + `BASE_URL=http://host.docker.internal:3000`

> mkcert/자체서명 인증서라면 `INSECURE_SKIP_TLS_VERIFY=true` 설정을 권장합니다.

## Reset Wrapper

- `make k6-reset` / `make k6-local-reset` 는 k6 실행 전에 `POST /api/internal/loadtest/reset-rtb-state` 를 먼저 호출합니다.
- reset 호출은 **호스트 셸에서 실행**되므로, `RESET_BASE_URL` 은 보통 `http://localhost:3000` 처럼 호스트 기준 주소여야 합니다.
- backend 쪽에 아래 환경변수가 설정되어 있어야 합니다.
    - `LOADTEST_RESET_ENABLED=true`
    - `LOADTEST_RESET_TOKEN=<same-token>`
- `.loadtest/.env` 쪽에도 같은 토큰을 `LOADTEST_RESET_TOKEN` 으로 넣어야 wrapper가 동작합니다.
- 기본 reset 옵션은 `force=true`, `clearLogs=true`, `clearAuxRedisKeys=true`, `drainBidlogQueue=true` 입니다.
- 특정 캠페인만 초기화하려면 `RESET_CAMPAIGN_IDS=campaign-a,campaign-b` 형태로 지정하세요.
- RTB suite는 각 cell을 백엔드 재시작으로 격리하지 않고 reset API로 DB/Redis spent, 로그, 보조 키, queue 상태를 초기화합니다.
- 분석 결과의 `budgetPressureObserved`는 reset 실패가 아니라 해당 cell 실행 중 reservation rejection이 발생했다는 뜻입니다.

### 배포 서버(프로덕션/스테이징)

- 보통은 `BASE_URL=https://<배포 도메인>` 으로 두고 실행합니다. (예: `https://www.boostad.site`)
- **권장**: 배포 서버 자체에서 부하를 생성하면(같은 머신에서 k6 실행) 서비스 자원과 경쟁해서 지표가 왜곡될 수 있어요. 가능하면 별도 로드 제너레이터(다른 VM/로컬)에서 쏘세요.
- 이 프로젝트 백엔드는 `ThrottlerGuard`가 전역 적용되어 있어(기본: IP당 60초 100회) 단일 IP로 고RPS를 쏘면 429가 많이 나올 수 있습니다.

## 포함된 시나리오

- `k6/http/rtb-decision.js`: `POST /api/sdk/decision` (RTB 의사결정)
- `k6/sse/advertiser-bids-stream.js`: `GET /api/advertiser/bids/stream` (광고주 실시간 입찰 SSE)
    - `ACCESS_TOKEN` 쿠키(JWT)가 필요합니다.

## 프로덕션 대상 주의사항

- `/api/sdk/decision`은 **BidLog 저장 / 예산(spent) 증가 등 상태 변경이 발생**합니다. 프로덕션에 쏠 땐 테스트용 캠페인/블로그키로만 수행하거나 스테이징에서 진행을 권장합니다.
- 작은 부하에서 시작해서(예: `VUS=1`, `DURATION=10s`) 단계적으로 올리고, DB/Redis/CPU/에러율을 같이 관찰하세요.

## SSE 실행 메모

`k6/sse/advertiser-bids-stream.js`는 `k6/x/sse` 확장을 사용합니다.

- (가능하면) **k6 v1+** 환경에서는 자동 확장 해석이 동작해 바로 실행될 수 있습니다.
- Docker 이미지에서 확장 해석이 막혀있거나(네트워크 차단/버전 이슈) 실패하면, 아래 커스텀 이미지를 빌드해서 실행하세요.

```bash
cd loadtest
make k6-sse-image
K6_IMAGE=boostad-k6-sse:local make k6 SCRIPT=k6/sse/advertiser-bids-stream.js
```

### baseline 부하테스트

```shell
cd /Users/kitae/Park_inglot/Park_inglot/sideproject/web27-BoostAD/.loadtest

LOADTEST_RESET_TOKEN=boostad-loadtest-reset-local \
RESET_BASE_URL=http://localhost:3000 \
BASE_URL=http://localhost:3000 \
SCENARIO=constant-arrival-rate \
RATE=30 DURATION=1m SLEEP=0 \
BLOG_KEY=test-blog POST_URL=http://127.0.0.1/posts/1 \
make k6-local-reset SCRIPT=k6/http/rtb-decision.js
```

### Random pool 부하테스트

```shell
LOADTEST_RESET_TOKEN=boostad-loadtest-reset-local \
RESET_BASE_URL=http://localhost:3000 \
BASE_URL=http://localhost:3000 \
SCENARIO=constant-arrival-rate \
RATE=30 DURATION=1m SLEEP=0 \
BLOG_KEY=test-blog POST_URL=http://127.0.0.1/posts/1 \
REQUEST_POOL_SIZE=1000 \
TAGS_PER_REQUEST=3 \
HIGH_INTENT_RATIO=0.2 \
BEHAVIOR_SCORE_MIN=20 \
BEHAVIOR_SCORE_MAX=90 \
RANDOM_POOL_PICK=true \
MUTATE_PER_REQUEST=true \
make k6-local-reset SCRIPT=k6/http/rtb-decision-random-pool.js
```

### docker 빌드용 cli

```shell
docker compose -p web27-boostcamp \
  -f docker-compose.local.yml \
  -f docker-compose.local.backend.yml \
  up -d --build --no-deps backend

```
