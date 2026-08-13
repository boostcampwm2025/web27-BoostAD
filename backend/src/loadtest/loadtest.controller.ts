import { Body, Controller, Headers, Post } from '@nestjs/common';
import { Public } from 'src/auth/decorators/public.decorator';
import { successResponse } from 'src/common/response/success-response';
import { ResetRtbStateDto } from './dto/reset-rtb-state.dto';
import {
  ExtractQualityRankingsDto,
  LoadQualityCampaignsDto,
  RestoreQualityCampaignsDto,
} from './dto/quality-benchmark.dto';
import { LoadtestService } from './loadtest.service';
import { QualityBenchmarkService } from './quality-benchmark.service';

@Public()
@Controller('internal/loadtest')
export class LoadtestController {
  constructor(
    private readonly loadtestService: LoadtestService,
    private readonly qualityBenchmarkService: QualityBenchmarkService
  ) {}

  @Post('reset-rtb-state')
  async resetRtbState(
    @Headers('x-loadtest-reset-token') resetToken: string | undefined,
    @Body() dto: ResetRtbStateDto
  ) {
    const result = await this.loadtestService.resetRtbState(dto, resetToken);

    return successResponse(result, 'RTB loadtest 상태를 초기화했습니다.');
  }

  @Post('quality/load-campaigns')
  async loadQualityCampaigns(
    @Headers('x-loadtest-reset-token') resetToken: string | undefined,
    @Body() dto: LoadQualityCampaignsDto
  ) {
    const result = await this.qualityBenchmarkService.loadCampaigns(
      dto,
      resetToken
    );
    return successResponse(result, 'Phase 4 품질 캠페인을 적재했습니다.');
  }

  @Post('quality/extract-rankings')
  async extractQualityRankings(
    @Headers('x-loadtest-reset-token') resetToken: string | undefined,
    @Body() dto: ExtractQualityRankingsDto
  ) {
    const result = await this.qualityBenchmarkService.extractRankings(
      dto,
      resetToken
    );
    return successResponse(result, 'Reserve 없이 품질 ranking을 추출했습니다.');
  }

  @Post('quality/restore-campaigns')
  async restoreQualityCampaigns(
    @Headers('x-loadtest-reset-token') resetToken: string | undefined,
    @Body() dto: RestoreQualityCampaignsDto
  ) {
    const result = await this.qualityBenchmarkService.restoreCampaigns(
      dto.sessionId,
      resetToken
    );
    return successResponse(
      result,
      '기존 serving campaign cache를 복원했습니다.'
    );
  }
}
