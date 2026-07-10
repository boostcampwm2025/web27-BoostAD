import { Injectable, OnApplicationBootstrap, Logger } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';

import { MLEngine } from './mlEngine.interface';
import { pipeline, Pipeline, Tensor } from '@xenova/transformers';

@Injectable()
export class XenovaMLEngine extends MLEngine implements OnApplicationBootstrap {
  private readonly logger = new Logger(XenovaMLEngine.name);
  private embedder: Pipeline | null = null;
  private modelReady = false;

  // 사용할 모델과 태스크 정의
  private static readonly TASK = 'feature-extraction';
  private static readonly MODEL = 'Xenova/all-MiniLM-L6-v2';
  private static readonly MODEL_VERSION =
    'Xenova/all-MiniLM-L6-v2@request-v1-mean-normalized';
  private static readonly EMBEDDING_DIMENSION = 384;

  constructor(private readonly eventEmitter: EventEmitter2) {
    super();
  }

  // 애플리케이션 부트스트랩 시 모델 로드 (모든 모듈 초기화 완료 후)
  async onApplicationBootstrap() {
    this.logger.log('🔄 Transformer 모델 로딩 중');
    try {
      await this.loadModel();
      this.modelReady = true;
      this.logger.log(
        `✅ ${XenovaMLEngine.MODEL}이 성공적으로 로드 되었습니다!`
      );

      // 모델 로딩 완료 이벤트 발행 (모든 리스너가 등록된 후)
      this.eventEmitter.emit('ml.model.ready');
      this.logger.log('📢 ml.model.ready 이벤트 발행 완료');
    } catch (error) {
      this.logger.error('모델 로드를 실패하였습니다.:', error);
      this.modelReady = false;
    }
  }

  // 모델 로딩 완료 여부를 반환합니다.
  isReady(): boolean {
    return this.modelReady;
  }

  getModelVersion(): string {
    return XenovaMLEngine.MODEL_VERSION;
  }

  getEmbeddingDimension(): number {
    return XenovaMLEngine.EMBEDDING_DIMENSION;
  }

  // 입력된 텍스트의 임베딩 벡터를 생성합니다.
  async getEmbedding(text: string): Promise<number[]> {
    if (!this.embedder) {
      throw new Error('모델이 아직 로드되지 않았습니다.');
    }

    const result: Tensor = await this.embedder(text, {
      pooling: 'mean',
      normalize: true,
    });

    const embeddings = result.tolist() as number[][]; // [[0.1, 0.2, ...]]

    if (!embeddings || !embeddings[0]) {
      throw new Error('임베딩 생성에 실패했습니다.');
    }

    return embeddings?.[0]; // Tensor객체의 값을 배열로 변환 (2차원 배열이므로 첫 번째 요소 추출)
  }

  // 두 벡터 간의 코사인 유사도를 계산합니다.
  calculateSimilarity(
    vecA: ArrayLike<number>,
    vecB: ArrayLike<number>
  ): number {
    if (vecA.length !== vecB.length) {
      throw new Error(
        `Vector 차원이 일치해야 유사도 비교가 가능합니다.: ${vecA.length} vs ${vecB.length}`
      );
    }

    let dotProduct = 0;
    for (let index = 0; index < vecA.length; index++) {
      dotProduct += vecA[index] * vecB[index];
    }
    return Math.max(0, Math.min(1, dotProduct));
  }

  // 두 텍스트 간의 유사도를 계산합니다.
  async computeTextSimilarity(textA: string, textB: string): Promise<number> {
    const [embA, embB] = await Promise.all([
      this.getEmbedding(textA),
      this.getEmbedding(textB),
    ]);
    return this.calculateSimilarity(embA, embB);
  }

  // Xenova Transformer 모델을 pipleline으로 로드합니다.
  private async loadModel() {
    this.embedder = await pipeline(XenovaMLEngine.TASK, XenovaMLEngine.MODEL);
  }
}
