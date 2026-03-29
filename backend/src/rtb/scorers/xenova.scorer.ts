import { Injectable } from '@nestjs/common';
import { Scorer } from './scorer.interface';
import type { Candidate, ScoredCandidate } from '../types/decision.types';
import {
  createRtbPathLogger,
  rtbPathLogsEnabled,
} from '../../common/logging/rtb-path-logger.util';

@Injectable()
export class TransformerScorer extends Scorer {
  private readonly logger = createRtbPathLogger(TransformerScorer.name);
  private readonly logsEnabled = rtbPathLogsEnabled();
  private readonly CPC_WEIGHT = 0.3;
  private readonly SIMILARITY_WEIGHT = 0.7;

  constructor() {
    super();
  }

  // 현재 hot path에서는 사용하지 않지만, Candidate -> ScoredCandidate 계약은 유지합니다.
  async scoreCandidates(candidates: Candidate[]): Promise<ScoredCandidate[]> {
    return Promise.all(
      candidates.map((candidate) => {
        const cpcScore = candidate.maxCpc * this.CPC_WEIGHT;
        const similarityScore =
          candidate.similarity * 100 * this.SIMILARITY_WEIGHT;
        const score = cpcScore + similarityScore;

        if (this.logsEnabled) {
          this.logger.debug(
            `Campaign ${candidate.id}: ` +
              `Similarity=${candidate.similarity.toFixed(3)}, ` +
              `Total=${score.toFixed(1)}점`
          );
        }

        return Promise.resolve({
          ...candidate,
          score,
        });
      })
    );
  }
}
