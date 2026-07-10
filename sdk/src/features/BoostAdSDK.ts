import type {
  TagExtractor,
  APIClient,
  AdRenderer,
  BehaviorTracker,
  Tag,
} from '@shared/types';

// 티스토리 전역 객체 타입 정의
interface TistoryGlobal {
  type?: 'post' | 'page' | 'list' | 'category';
}

declare global {
  interface Window {
    tistory?: TistoryGlobal;
  }
}

// BoostAD SDK 메인 클래스 (전략 패턴)
export class BoostAdSDK {
  private hasRequestedSecondAd = false;
  private mutationObserver: MutationObserver | null = null;
  private renderedZones = new Set<Element>(); // SPA 라우팅 대응: 이미 렌더링된 zone 추적
  private debounceTimer: ReturnType<typeof setTimeout> | null = null; // DOM 변화 감지 디바운스
  private contextId: string | undefined;
  private contextUrl: string | undefined;
  private readonly CONTEXT_BODY_MAX_CHARS = 8_000;
  private readonly CONTENT_SELECTORS = [
    '#article',
    '#area_view',
    '#article-view',
    '#mArticle',
    '.blogview_content',
    '.article-view',
    '.article-content',
    '.post-content',
    '.entry-content',
    '.content',
    'article',
    '[class*="content"]',
    '[class*="article"]',
  ];

  constructor(
    private readonly tagExtractor: TagExtractor,
    private readonly apiClient: APIClient,
    private readonly adRenderer: AdRenderer,
    private readonly behaviorTracker: BehaviorTracker,
    private readonly isAutoMode: boolean
  ) {}

  async init(): Promise<void> {
    if (this.isAutoMode) {
      await this.initAutoMode();
    } else {
      await this.initManualMode();
    }
  }

  // ========================================
  // 공통 메서드
  // ========================================

  private async fetchAndRenderAd(
    container: HTMLElement,
    tags: Tag[],
    postUrl: string,
    behaviorScore: number,
    isHighIntent: boolean
  ): Promise<void> {
    try {
      const data = await this.apiClient.fetchDecision(
        tags,
        postUrl,
        behaviorScore,
        isHighIntent,
        this.contextId
      );

      // 광고 후보가 없는 경우 처리 (아무것도 표시하지 않음)
      if (!data || !data.data || !data.data.campaign) {
        console.warn('[BoostAD SDK] 표시할 광고가 없습니다.');
        container.remove(); // 컨테이너 자체를 제거
        return;
      }

      this.adRenderer.render(
        data.data.campaign,
        container,
        data.data.auctionId,
        postUrl,
        behaviorScore,
        isHighIntent
      );
    } catch (error) {
      console.error('[BoostAD SDK] 광고 로드 실패:', error);
      container.remove(); // 에러 시에도 컨테이너 제거
    }
  }

  private createAdContainer(id: string): HTMLElement {
    const container = document.createElement('div');
    container.id = id;
    container.style.margin = '30px 0';
    return container;
  }

  // ========================================
  // 자동 모드 (블로그)
  // ========================================

  private async initAutoMode(): Promise<void> {
    if (!this.isPostPage()) {
      return;
    }

    const tags = this.tagExtractor.extract();
    const postUrl = window.location.href;
    await this.ensureContextObserved(tags, postUrl);

    // 1차 광고: 본문 상단에 삽입
    const firstAdContainer = this.createAdContainer('boostad-first-ad');
    const insertionPoint = this.findContentTop();

    if (insertionPoint) {
      insertionPoint.before(firstAdContainer);

      await this.fetchAndRenderAd(firstAdContainer, tags, postUrl, 0, false);
    }

    // 행동 추적 시작 + 70점 도달 시 2차 광고 요청 (스크롤 위치에 삽입)
    this.behaviorTracker.onThresholdReached(() => {
      this.requestSecondAdAutoMode(tags, postUrl);
    });
    this.behaviorTracker.start();
  }

  private async requestSecondAdAutoMode(
    tags: Tag[],
    postUrl: string
  ): Promise<void> {
    if (this.hasRequestedSecondAd) return;
    this.hasRequestedSecondAd = true;

    const score = this.behaviorTracker.getCurrentScore();
    const isHighIntent = this.behaviorTracker.isHighIntent();

    // 1차 광고 제거
    document.getElementById('boostad-first-ad')?.remove();

    // 2차 광고: 현재 스크롤 위치에 삽입
    const secondAdContainer = this.createAdContainer('boostad-second-ad');
    const insertionPoint = this.findScrollBasedInsertionPoint();

    if (insertionPoint) {
      insertionPoint.after(secondAdContainer);

      await this.fetchAndRenderAd(
        secondAdContainer,
        tags,
        postUrl,
        score,
        isHighIntent
      );
    }
  }

  private isPostPage(): boolean {
    const pathname = window.location.pathname;
    const tistory = window.tistory;

    // Tistory 블로그인 경우 - tistory.type 우선 확인
    if (tistory && tistory.type) {
      return tistory.type === 'post';
    }

    // Tistory 블로그지만 tistory.type이 없는 경우 - URL 기반 판별
    const isTistoryDomain = window.location.hostname.includes('tistory.com');

    if (isTistoryDomain) {
      // 티스토리 제외 경로
      const tistoryExcludePatterns = [
        '/category',
        '/tag',
        '/archive',
        '/guestbook',
        '/notice',
        '/search',
        '/manage',
        '/admin',
      ];

      // 메인 페이지 제외
      if (pathname === '/' || pathname === '') {
        return false;
      }

      // 제외 패턴에 해당하면 false
      if (tistoryExcludePatterns.some((p) => pathname.startsWith(p))) {
        return false;
      }

      // 숫자 ID (/123) 또는 /entry/ 경로는 포스트
      const isNumericId = /^\/\d+$/.test(pathname);
      const isEntryPath = pathname.startsWith('/entry/');

      return isNumericId || isEntryPath;
    }

    // 일반 웹페이지: 제외 목록만 체크
    const excludePatterns = ['/admin', '/manage', '/login', '/signup'];

    if (excludePatterns.some((p) => pathname.startsWith(p))) {
      return false;
    }

    // 그 외 모든 페이지는 콘텐츠 페이지로 간주
    return true;
  }

  private findContentTop(): Element | null {
    for (const selector of this.CONTENT_SELECTORS) {
      const contentArea = document.querySelector(selector);
      if (contentArea) {
        const firstElement = contentArea.querySelector('p, h2');
        if (firstElement) return firstElement;
      }
    }
    return null;
  }

  private async ensureContextObserved(
    tags: Tag[],
    postUrl: string
  ): Promise<void> {
    if (this.contextUrl === postUrl) {
      return;
    }
    this.contextUrl = postUrl;
    const contentArea = this.findContentArea();
    const title =
      document.querySelector('h1')?.textContent?.trim() || document.title;
    const body = contentArea?.textContent
      ?.trim()
      .slice(0, this.CONTEXT_BODY_MAX_CHARS);
    this.contextId = await this.apiClient.observeContext(
      tags,
      postUrl,
      title,
      body
    );
  }

  private findContentArea(): Element | null {
    for (const selector of this.CONTENT_SELECTORS) {
      const contentArea = document.querySelector(selector);
      if (contentArea) {
        return contentArea;
      }
    }
    return null;
  }

  private findScrollBasedInsertionPoint(): Element | null {
    // 본문 영역 찾기
    let contentArea: Element | null = null;
    for (const selector of this.CONTENT_SELECTORS) {
      contentArea = document.querySelector(selector);
      if (contentArea) break;
    }

    if (!contentArea) {
      console.warn('[BoostAD SDK] 본문 영역을 찾을 수 없습니다');
      return null;
    }

    const paragraphs = contentArea.querySelectorAll('p');
    if (paragraphs.length === 0) {
      console.warn('[BoostAD SDK] <p> 태그를 찾을 수 없습니다');
      return null;
    }

    const scrollY = window.scrollY;
    const viewportHeight = window.innerHeight;
    const targetY = scrollY + viewportHeight;

    const contentRect = contentArea.getBoundingClientRect();
    const contentBottom = contentRect.bottom + scrollY;

    // 스크롤이 본문 끝을 넘어섰다면 마지막 <p> 반환
    if (targetY > contentBottom) {
      return paragraphs[paragraphs.length - 1];
    }

    // 본문 내에서 스크롤 위치에 가장 가까운 <p> 찾기
    let closestParagraph: Element | null = null;
    let minDistance = Infinity;

    paragraphs.forEach((p) => {
      const rect = p.getBoundingClientRect();
      const pTop = rect.top + scrollY;
      const distance = Math.abs(pTop - targetY);

      if (distance < minDistance) {
        minDistance = distance;
        closestParagraph = p;
      }
    });

    return closestParagraph;
  }

  // ========================================
  // 수동 모드 (일반 웹페이지)
  // ========================================

  private async initManualMode(): Promise<void> {
    // 초기 로드된 zone 체크
    await this.checkAndLoadAds();

    // MutationObserver 시작 (SPA 라우팅 대응)
    this.setupMutationObserver();
  }

  // MutationObserver 설정 (React 등 SPA의 동적 DOM 변화 감지)
  private setupMutationObserver(): void {
    this.mutationObserver = new MutationObserver(() => {
      // Debounce: 100ms 동안 추가 변화가 없으면 실행
      if (this.debounceTimer) {
        clearTimeout(this.debounceTimer);
      }
      this.debounceTimer = setTimeout(() => {
        this.checkAndLoadAds();
      }, 100);
    });

    // body 전체를 감시 (하위 요소 포함)
    this.mutationObserver.observe(document.body, {
      childList: true,
      subtree: true,
    });
  }

  // 광고존 체크 및 로드
  private async checkAndLoadAds(): Promise<void> {
    const allZones = document.querySelectorAll('[data-boostad-zone]');

    if (allZones.length === 0) {
      return; // zone이 없으면 아무것도 안 함
    }

    // 새로운 광고존만 필터링 (이미 렌더링된 zone 제외)
    const newZones = Array.from(allZones).filter(
      (zone) => !this.renderedZones.has(zone)
    );

    if (newZones.length === 0) {
      return;
    }

    await this.loadAdsForZones(newZones);
  }

  // 광고존에 광고 로드 (중복 렌더링 방지)
  private async loadAdsForZones(zones: Element[]): Promise<void> {
    const limitedZones = zones.slice(0, 2);

    if (zones.length > 2) {
      console.warn(
        `[BoostAD SDK] 광고존은 최대 2개까지 허용됩니다. ${zones.length}개 중 처음 2개만 사용합니다.`
      );
    }

    limitedZones.forEach((zone) => this.renderedZones.add(zone));

    const tags = this.tagExtractor.extract();
    const postUrl = window.location.href;
    await this.ensureContextObserved(tags, postUrl);

    // 각 광고존에 광고 삽입 (수동 모드는 행동 추적 없이 광고만 표시)
    for (const zone of limitedZones) {
      const container = zone as HTMLElement;
      container.style.margin = '30px 0';

      await this.fetchAndRenderAd(container, tags, postUrl, 0, false);
    }

    // 수동 모드에서는 행동 추적 및 2차 광고 제거
    // (개인정보 보호를 위해 명시적 동의 없이는 추적하지 않음)
  }
}
