import { Injectable, Logger } from '@nestjs/common';
import { Scorer } from './scorer.interface';
// import { MLEngine } from '../ml/mlEngine.interface';
import type { Candidate, ScoredCandidate } from '../types/decision.types';
import {
  createRtbPathLogger,
  rtbPathLogsEnabled,
} from '../../common/logging/rtb-path-logger.util';

@Injectable()
export class TransformerScorer extends Scorer {
  private readonly logger = createRtbPathLogger(TransformerScorer.name);
  private readonly logsEnabled = rtbPathLogsEnabled();

  // 점수 공식 가중치 (설정으로 분리)
  private readonly CPC_WEIGHT = 0.3;
  private readonly SIMILARITY_WEIGHT = 0.7;

  constructor() {
    super();
  }

  // 여러 캠페인 후보의 점수를 병렬(비동기)로 계산합니다.
  async scoreCandidates(candidates: Candidate[]): Promise<ScoredCandidate[]> {
    return Promise.all(
      candidates.map((candidate) => this.scoreCandidate(candidate))
    );
  }

  // 단일 캠페인의 점수를 계산합니다.
  private scoreCandidate(candidate: Candidate): Promise<ScoredCandidate> {
    const { campaign, similarity } = candidate;

    // 매칭된 태그 계산 (현재 사용 안 함) 참고용으로 남겨둠
    // const matchedTags = campaign.tags.filter((tag) =>
    //   context.tags.includes(tag.name)
    // );

    // 점수 계산: CPC * 0.3 + Similarity * 70
    const cpc = campaign.maxCpc;
    const cpcScore = cpc * this.CPC_WEIGHT;
    const similarityScore = similarity * 100 * this.SIMILARITY_WEIGHT;
    const finalScore = cpcScore + similarityScore;

    if (this.logsEnabled) {
      this.logger.debug(
        `Campaign ${campaign.id}: ` +
          `CPC=${cpc}(${cpcScore.toFixed(1)}점), ` +
          `Similarity=${similarity.toFixed(3)}(${similarityScore.toFixed(1)}점), ` +
          `Total=${finalScore.toFixed(1)}점`
      );
    }

    return Promise.resolve({
      ...campaign,
      score: finalScore,
    });
  }
}
