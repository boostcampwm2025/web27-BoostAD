import type {
  APIClient,
  DecisionRequest,
  DecisionResponse,
  ContextObserveRequest,
  ContextObserveResponse,
  SDKConfig,
  Tag,
} from '@shared/types';
import { API_BASE_URL } from '@shared/config/constants';

// Decision API 클라이언트 (광고 가져오기)
export class DecisionAPIClient implements APIClient {
  constructor(private readonly config: SDKConfig) {}

  async fetchDecision(
    tags: Tag[],
    postUrl: string,
    behaviorScore: number = 0,
    isHighIntent: boolean = false,
    contextId?: string
  ): Promise<DecisionResponse> {
    let requestBody: DecisionRequest;

    if (this.config.context) {
      requestBody = {
        blogKey: this.config.blogKey,
        tags: [this.config.context],
        postUrl,
        behaviorScore,
        isHighIntent,
        ...(contextId ? { contextId } : {}),
      };
    } else {
      requestBody = {
        blogKey: this.config.blogKey,
        tags: tags.map((tag) => tag.name),
        postUrl,
        behaviorScore,
        isHighIntent,
        ...(contextId ? { contextId } : {}),
      };
    }

    try {
      const response = await fetch(`${API_BASE_URL}/sdk/decision`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        credentials: 'include',
        body: JSON.stringify(requestBody),
      });

      if (!response.ok) {
        throw new Error(`API 오류: ${response.status} ${response.statusText}`);
      }

      return await response.json();
    } catch (error) {
      console.error('[BoostAD SDK] API 호출 실패:', error);
      // API 실패 시 빈 응답 반환 (광고 없음 상태)
      return {
        status: 'error',
        message: 'API 호출 실패',
        data: {
          campaign: null,
          auctionId: '',
        },
        timestamp: new Date().toISOString(),
      };
    }
  }

  async observeContext(
    tags: Tag[],
    postUrl: string,
    title?: string,
    body?: string
  ): Promise<string | undefined> {
    const requestBody: ContextObserveRequest = {
      blogKey: this.config.blogKey,
      postUrl,
      title,
      body,
      tags: this.config.context
        ? [this.config.context]
        : tags.map((tag) => tag.name),
    };

    try {
      const response = await fetch(`${API_BASE_URL}/sdk/context/observe`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify(requestBody),
      });
      if (!response.ok) {
        throw new Error(`Context API 오류: ${response.status}`);
      }
      const result = (await response.json()) as ContextObserveResponse;
      return result.status === 'FAILED' ? undefined : result.contextId;
    } catch (error) {
      console.warn('[BoostAD SDK] context observe 실패, tag 경로 사용:', error);
      return undefined;
    }
  }
}
