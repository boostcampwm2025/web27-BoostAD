import { Injectable, Logger } from '@nestjs/common';
import { CampaignSelector } from './selector.interface';
import type { ScoredCandidate, SelectionResult } from '../types/decision.types';
import {
  createRtbPathLogger,
  rtbPathLogsEnabled,
} from '../../common/logging/rtb-path-logger.util';

@Injectable()
export class PrototypeCampaignSelector implements CampaignSelector {
  private readonly logger = createRtbPathLogger(PrototypeCampaignSelector.name);
  private readonly logsEnabled = rtbPathLogsEnabled();

  async selectWinner(candidates: ScoredCandidate[]): Promise<SelectionResult> {
    // 점수 내림차순 정렬 (동점자 비교)
    const sorted = [...candidates].sort((a, b) => {
      // 1차: 점수 비교
      if (b.score !== a.score) {
        return b.score - a.score;
      }

      // 2차: 동점이면 max_cpc 비교
      if (b.maxCpc !== a.maxCpc) {
        return b.maxCpc - a.maxCpc;
      }

      // 3차: 점수와 maxCpc가 모두 같으면 랜덤 정렬
      return Math.random() - 0.5;
    });

    // 동점 + 동일 CPC 캠페인 로깅
    const topScore = sorted[0]?.score;
    const topCpc = sorted[0]?.maxCpc;
    const fullyTiedCandidates = sorted.filter(
      (c) => c.score === topScore && c.maxCpc === topCpc
    );

    if (this.logsEnabled && fullyTiedCandidates.length > 1) {
      this.logger.debug(
        `완전 동점 캠페인 ${fullyTiedCandidates.length}개 발견 ` +
          `(점수: ${topScore?.toFixed(1)}점, CPC: ${topCpc}원) - ` +
          `캠페인 ID: [${fullyTiedCandidates.map((c) => c.id).join(', ')}], ` +
          `랜덤 선택: ${sorted[0].id}`
      );
    }

    // 1등 = winner, 나머지 = candidates
    return Promise.resolve({
      winner: sorted[0],
      candidates: sorted,
    });
  }
}
