import { Injectable } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import {
  collectDefaultMetrics,
  Counter,
  Gauge,
  Histogram,
  Registry,
} from 'prom-client';

type HttpLabel = 'method' | 'route' | 'status_code';
type RtbStageLabel = 'stage' | 'outcome';
type RtbRequestLabel = 'result' | 'high_intent';
type RtbFallbackLabel = 'reason';
type RtbReservationFailureLabel = 'reason';
type RtbPayloadLabel = 'direction';
type DependencyLabel = 'dependency' | 'operation' | 'outcome';
type BidLogPubSubMessageLabel = 'result';
type BidLogPubSubEventLabel = 'result';
type QueueJobLabel = 'queue' | 'state';

@Injectable()
export class MetricsService {
  private readonly registry = new Registry();

  private readonly httpRequestsTotal = new Counter<HttpLabel>({
    name: 'boostad_http_requests_total',
    help: 'Http 요청 수 총합',
    labelNames: ['method', 'route', 'status_code'],
    registers: [this.registry],
  });

  private readonly httpRequestDurationSeconds = new Histogram<HttpLabel>({
    name: 'boostad_http_request_duration_seconds',
    help: 'HTTP 요청 처리 시간',
    labelNames: ['method', 'route', 'status_code'],
    buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2, 5],
    registers: [this.registry],
  });

  private readonly sseConnections = new Gauge<'stream'>({
    name: 'boostad_sse_connections',
    help: '현재 SSE 커넥션 개수',
    labelNames: ['stream'],
    registers: [this.registry],
  });

  private readonly inFlightHttpRequests = new Gauge({
    name: 'boostad_http_in_flight_requests',
    help: '현재 처리중인 Http 요청 수',
    registers: [this.registry],
  });

  private readonly rtbStageDurationSeconds = new Histogram<RtbStageLabel>({
    name: 'boostad_rtb_stage_duration_seconds',
    help: 'RTB stage 처리 시간',
    labelNames: ['stage', 'outcome'],
    buckets: [
      0.00001, 0.000025, 0.00005, 0.0001, 0.00025, 0.0005, 0.001, 0.005, 0.01,
      0.025, 0.05, 0.1, 0.25, 0.5, 1, 2, 5,
    ],
    registers: [this.registry],
  });

  private readonly rtbRequestsTotal = new Counter<RtbRequestLabel>({
    name: 'boostad_rtb_requests_total',
    help: 'RTB 요청 수',
    labelNames: ['result', 'high_intent'],
    registers: [this.registry],
  });

  private readonly rtbCandidateCount = new Histogram({
    name: 'boostad_rtb_candidate_count',
    help: 'RTB reserve 전 후보 수 분포',
    buckets: [1, 2, 5, 10, 20, 50, 100, 200, 500, 1000],
    registers: [this.registry],
  });

  private readonly rtbReserveAttemptCandidateCount = new Histogram({
    name: 'boostad_rtb_reserve_attempt_candidate_count',
    help: 'RTB reserve 단계에서 실제 시도한 후보 수 분포',
    buckets: [1, 2, 5, 10, 20, 50, 100, 200, 500, 1000],
    registers: [this.registry],
  });

  private readonly rtbReservedCandidateCount = new Histogram({
    name: 'boostad_rtb_reserved_candidate_count',
    help: 'RTB reserve 성공 후보 수 분포',
    buckets: [1, 2, 5, 10, 20, 50, 100, 200, 500, 1000],
    registers: [this.registry],
  });

  private readonly rtbReserveWindowAttemptCount = new Histogram({
    name: 'boostad_rtb_reserve_window_attempt_count',
    help: 'RTB reserve 성공 또는 종료 전까지 시도한 window 수 분포',
    buckets: [1, 2, 3, 5, 10, 20, 50, 100],
    registers: [this.registry],
  });

  private readonly rtbRollbackCandidateCount = new Histogram({
    name: 'boostad_rtb_rollback_candidate_count',
    help: 'RTB rollback 대상 후보 수 분포',
    buckets: [1, 2, 5, 10, 20, 50, 100, 200, 500, 1000],
    registers: [this.registry],
  });

  private readonly rtbEligibleCampaignCount = new Histogram({
    name: 'boostad_rtb_eligible_campaign_count',
    help: 'RTB eligible 캠페인 수 분포',
    buckets: [1, 2, 5, 10, 20, 50, 100, 200, 500, 1000],
    registers: [this.registry],
  });

  private readonly rtbAnnTagHitCount = new Histogram({
    name: 'boostad_rtb_ann_tag_hit_count',
    help: 'ANN retrieval이 반환한 tag hit 수 분포',
    buckets: [1, 2, 5, 10, 20, 50, 100, 200, 500, 1000],
    registers: [this.registry],
  });

  private readonly rtbAnnRetrievedCampaignCount = new Histogram({
    name: 'boostad_rtb_ann_retrieved_campaign_count',
    help: 'ANN retrieval 이후 exact rerank로 넘긴 캠페인 수 분포',
    buckets: [1, 2, 5, 10, 20, 50, 100, 200, 500, 1000],
    registers: [this.registry],
  });

  private readonly rtbBidLogCount = new Histogram({
    name: 'boostad_rtb_bidlog_count',
    help: '요청당 저장된 bid log 수 분포',
    buckets: [1, 2, 5, 10, 20, 50, 100, 200, 500, 1000],
    registers: [this.registry],
  });

  private readonly rtbFallbackTotal = new Counter<RtbFallbackLabel>({
    name: 'boostad_rtb_fallback_total',
    help: 'RTB fallback 발생 수',
    labelNames: ['reason'],
    registers: [this.registry],
  });

  private readonly rtbReservationFailuresTotal =
    new Counter<RtbReservationFailureLabel>({
      name: 'boostad_rtb_reservation_failures_total',
      help: 'RTB 예산 선점 실패 수',
      labelNames: ['reason'],
      registers: [this.registry],
    });

  private readonly rtbPayloadBytes = new Histogram<RtbPayloadLabel>({
    name: 'boostad_rtb_payload_bytes',
    help: 'RTB request/response payload bytes',
    labelNames: ['direction'],
    buckets: [128, 256, 512, 1024, 2048, 4096, 8192, 16384, 32768],
    registers: [this.registry],
  });

  private readonly dependencyDurationSeconds = new Histogram<DependencyLabel>({
    name: 'boostad_dependency_duration_seconds',
    help: '외부 의존성 호출 시간',
    labelNames: ['dependency', 'operation', 'outcome'],
    buckets: [0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2, 5],
    registers: [this.registry],
  });

  private readonly dependencyCallsTotal = new Counter<DependencyLabel>({
    name: 'boostad_dependency_calls_total',
    help: '외부 의존성 호출 수',
    labelNames: ['dependency', 'operation', 'outcome'],
    registers: [this.registry],
  });

  private readonly bidlogPubSubMessagesTotal =
    new Counter<BidLogPubSubMessageLabel>({
      name: 'boostad_bidlog_pubsub_messages_total',
      help: 'BidLog Redis pub/sub 메시지 처리 수',
      labelNames: ['result'],
      registers: [this.registry],
    });

  private readonly bidlogPubSubEventsTotal =
    new Counter<BidLogPubSubEventLabel>({
      name: 'boostad_bidlog_pubsub_events_total',
      help: 'BidLog pub/sub 이벤트 처리 수',
      labelNames: ['result'],
      registers: [this.registry],
    });

  private readonly bidlogPubSubBatchSize = new Histogram({
    name: 'boostad_bidlog_pubsub_batch_size',
    help: 'BidLog pub/sub 메시지당 이벤트 개수',
    buckets: [1, 2, 5, 10, 20, 50, 100, 200, 500],
    registers: [this.registry],
  });

  private readonly bidlogPubSubDeliveryLagSeconds = new Histogram({
    name: 'boostad_bidlog_pubsub_delivery_lag_seconds',
    help: 'BidLog worker publish부터 API fan-out까지 지연 시간',
    buckets: [0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2, 5],
    registers: [this.registry],
  });

  private readonly queueJobs = new Gauge<QueueJobLabel>({
    name: 'boostad_queue_jobs',
    help: 'BullMQ queue state별 job 수',
    labelNames: ['queue', 'state'],
    registers: [this.registry],
  });

  constructor(
    @InjectQueue('bidlog-queue')
    private readonly bidlogQueue: Queue
  ) {
    collectDefaultMetrics({
      register: this.registry,
      prefix: 'boostad_backend_',
      labels: { service: 'backend' },
    });
  }

  recordHttpRequest(
    method: string,
    route: string,
    statusCode: number,
    durationMs: number
  ): void {
    const labels = { method, route, status_code: String(statusCode) };
    this.httpRequestsTotal.inc(labels);
    this.httpRequestDurationSeconds.observe(labels, durationMs / 1000);
  }

  recordRtbStage(
    stage: string,
    outcome: 'ok' | 'error' | 'fallback',
    durationMs: number
  ) {
    this.rtbStageDurationSeconds.observe({ stage, outcome }, durationMs / 1000);
  }

  recordRtbRequest(
    result: 'success' | 'error' | 'fallback',
    highIntent?: boolean
  ) {
    this.rtbRequestsTotal.inc({
      result,
      high_intent: String(Boolean(highIntent)),
    });
  }

  observeRtbMatchedBeforeReserveCount(count: number) {
    this.rtbCandidateCount.observe(count);
  }

  observeRtbCandidateCount(count: number) {
    this.rtbCandidateCount.observe(count);
  }

  observeRtbReserveAttemptCandidateCount(count: number) {
    this.rtbReserveAttemptCandidateCount.observe(count);
  }

  observeRtbReservedCandidateCount(count: number) {
    this.rtbReservedCandidateCount.observe(count);
  }

  observeRtbReserveWindowAttemptCount(count: number) {
    this.rtbReserveWindowAttemptCount.observe(count);
  }

  observeRtbRollbackCandidateCount(count: number) {
    this.rtbRollbackCandidateCount.observe(count);
  }

  observeRtbEligibleCampaignCount(count: number) {
    this.rtbEligibleCampaignCount.observe(count);
  }

  observeRtbAnnTagHitCount(count: number) {
    this.rtbAnnTagHitCount.observe(count);
  }

  observeRtbAnnRetrievedCampaignCount(count: number) {
    this.rtbAnnRetrievedCampaignCount.observe(count);
  }

  observeRtbBidLogCount(count: number) {
    this.rtbBidLogCount.observe(count);
  }

  incRtbFallback(reason: string) {
    this.rtbFallbackTotal.inc({ reason });
  }

  incRtbReservationFailure(reason: string, count = 1) {
    if (count <= 0) {
      return;
    }
    this.rtbReservationFailuresTotal.inc({ reason }, count);
  }

  observeRtbPayload(direction: 'request' | 'response', bytes: number) {
    if (!Number.isFinite(bytes) || bytes < 0) {
      return;
    }

    this.rtbPayloadBytes.observe({ direction }, bytes);
  }

  recordDependency(
    dependency: string,
    operation: string,
    outcome: string,
    durationMs: number
  ) {
    const labels = { dependency, operation, outcome };
    this.dependencyCallsTotal.inc(labels);
    this.dependencyDurationSeconds.observe(labels, durationMs / 1000);
  }

  incBidlogPubSubMessage(
    result: 'received' | 'parse_error' | 'invalid_format'
  ) {
    this.bidlogPubSubMessagesTotal.inc({ result });
  }

  incBidlogPubSubEvent(result: 'received' | 'emitted' | 'no_listener') {
    this.bidlogPubSubEventsTotal.inc({ result });
  }

  observeBidlogPubSubBatchSize(size: number) {
    if (!Number.isFinite(size) || size < 0) {
      return;
    }

    this.bidlogPubSubBatchSize.observe(size);
  }

  observeBidlogPubSubDeliveryLag(durationMs: number) {
    if (!Number.isFinite(durationMs) || durationMs < 0) {
      return;
    }

    this.bidlogPubSubDeliveryLagSeconds.observe(durationMs / 1000);
  }

  incSseConnections(stream: string) {
    this.sseConnections.inc({ stream });
  }

  decSseConnections(stream: string) {
    this.sseConnections.dec({ stream });
  }

  incInFlightHttpRequest() {
    this.inFlightHttpRequests.inc();
  }
  decInFlightHttpRequest() {
    this.inFlightHttpRequests.dec();
  }

  getContentType(): string {
    return this.registry.contentType;
  }

  async getMetrics(): Promise<string> {
    await this.refreshQueueMetrics();
    return await this.registry.metrics(); // 레지스트리에 등록된 모든 메트릭 텍스트로 직렬화해서 리턴
  }

  private async refreshQueueMetrics(): Promise<void> {
    const counts = await this.bidlogQueue.getJobCounts(
      'waiting',
      'active',
      'delayed',
      'prioritized',
      'paused',
      'completed',
      'failed'
    );

    const queueName = this.bidlogQueue.name;
    const entries = Object.entries(counts);

    for (const [state, count] of entries) {
      this.queueJobs.set(
        { queue: queueName, state },
        Number.isFinite(count) ? count : 0
      );
    }
  }
}
