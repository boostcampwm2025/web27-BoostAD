export abstract class MLEngine {
  /**
   * 서비스 초기화 완료 여부 (모델 로딩 상태)
   */
  abstract isReady(): boolean;

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
   * @returns 임베딩 벡터 (384차원)
   */
  abstract getEmbedding(text: string): Promise<number[]>;

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
