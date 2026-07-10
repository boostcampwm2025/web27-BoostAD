// SDK 설정 타입 (스크립트 태그의 data-* 속성)
export interface SDKConfig {
  blogKey: string;
  auto: boolean; // true: 자동 모드 (블로그), false: 수동 모드 (광고존 직접 지정)
  context?: string;
}

// 태그 타입
export interface Tag {
  id: number;
  name: string;
}

// 광고 캠페인 타입 (순수 캠페인 정보)
export interface Campaign {
  id: string;
  title: string;
  content: string;
  image: string;
  url: string;
  tags: Tag[];
}

// Decision API 요청 타입
export interface DecisionRequest {
  blogKey: string;
  tags: string[];
  postUrl: string;
  behaviorScore: number;
  isHighIntent: boolean;
  contextId?: string;
}

export interface ContextObserveRequest {
  blogKey: string;
  postUrl: string;
  title?: string;
  body?: string;
  tags: string[];
}

export interface ContextObserveResponse {
  status: 'READY' | 'PENDING' | 'FAILED';
  contextId: string;
  contentHash: string;
  timestamp: string;
}

// Decision API 응답 타입
export interface DecisionResponse {
  status: string;
  message: string;
  data: {
    campaign: Campaign | null;
    auctionId: string;
  };
  timestamp: string;
}

// ViewLog API 요청 타입
export interface ViewLogRequest {
  blogKey: string;
  auctionId: string;
  campaignId: string;
  postUrl: string;
  isHighIntent: boolean;
  behaviorScore: number;
  positionRatio: number | null;
}

// ViewLog API 응답 타입
export interface ViewLogResponse {
  status: string;
  message: string;
  data: {
    viewId: number;
  };
  timestamp: string;
}

// ClickLog API 요청 타입
export interface ClickLogRequest {
  viewId: number;
  blogKey: string;
  postUrl: string;
}

// ClickLog API 응답 타입
export interface ClickLogResponse {
  status: string;
  message: string;
  data: {
    clickId: number;
  };
  timestamp: string;
}

// DismissLog API 요청 타입
export interface DismissLogRequest {
  viewId: number;
  blogKey: string;
  postUrl: string;
}

// 전략 패턴 인터페이스들
export interface TagExtractor {
  extract(): Tag[];
}

export interface APIClient {
  fetchDecision(
    tags: Tag[],
    postUrl: string,
    behaviorScore?: number,
    isHighIntent?: boolean,
    contextId?: string
  ): Promise<DecisionResponse>;
  observeContext(
    tags: Tag[],
    postUrl: string,
    title?: string,
    body?: string
  ): Promise<string | undefined>;
}

export interface AdRenderer {
  render(
    campaign: Campaign | null,
    container: HTMLElement,
    auctionId: string,
    postUrl?: string,
    behaviorScore?: number,
    isHighIntent?: boolean
  ): void;
}

export interface BehaviorTracker {
  start(): void; // 행동 추적 시작 (이벤트 리스너 등록)
  stop(): void; // 행동 추적 중지 (이벤트 리스너 제거)
  getCurrentScore(): number; // 현재 점수 반환
  isHighIntent(): boolean; // 70점 이상인지 확인
  onThresholdReached(callback: () => void): void; // 70점 도달 시 콜백 실행
}
