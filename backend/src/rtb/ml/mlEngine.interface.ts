import type { EmbeddingProfileName, EmbeddingRole } from './embedding-profile';

export abstract class MLEngine {
  /**
   * 서비스 초기화 완료 여부 (모델 로딩 상태)
   */
  abstract isReady(): boolean;

  /**
   * 실행 중인 profile. 운영 manifest와 model/index 일치 검증에 사용한다.
   */
  abstract getProfileName(): EmbeddingProfileName;

  /**
   * 실제로 로드하는 Hugging Face/Xenova model id.
   */
  abstract getModelId(): string;

  /**
   * Cache key isolation용 모델 식별자
   */
  abstract getModelVersion(): string;

  /**
   * 캐시 payload 검증에 사용하는 임베딩 차원
   */
  abstract getEmbeddingDimension(): number;

  /**
   * 텍스트 or 단어를 벡터로 변환
   * @param text - 변환할 텍스트 (예: "React TypeScript Hooks")
   * @returns 현재 profile이 정의한 차원의 임베딩 벡터
   */
  abstract getEmbedding(text: string, role?: EmbeddingRole): Promise<number[]>;

  /**
   * 두 벡터 간의 코사인 유사도 계산
   * @param vecA - 첫 번째 벡터
   * @param vecB - 두 번째 벡터
   * @returns 유사도 (0.0 ~ 1.0)
   */
  abstract calculateSimilarity(
    vecA: ArrayLike<number>,
    vecB: ArrayLike<number>
  ): number;

  /**
   * 두 텍스트 간의 유사도를 직접 계산 (헬퍼 메서드)
   * @param textA - 첫 번째 텍스트
   * @param textB - 두 번째 텍스트
   * @returns 유사도 (0.0 ~ 1.0)
   */
  abstract computeTextSimilarity(textA: string, textB: string): Promise<number>;
}
