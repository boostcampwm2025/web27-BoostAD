import { Body, Controller, Headers, Post } from '@nestjs/common';
import { Public } from 'src/auth/decorators/public.decorator';
import { successResponse } from 'src/common/response/success-response';
import { ResetRtbStateDto } from './dto/reset-rtb-state.dto';
import { LoadtestService } from './loadtest.service';

@Public()
@Controller('internal/loadtest')
export class LoadtestController {
  constructor(private readonly loadtestService: LoadtestService) {}

  @Post('reset-rtb-state')
  async resetRtbState(
    @Headers('x-loadtest-reset-token') resetToken: string | undefined,
    @Body() dto: ResetRtbStateDto
  ) {
    const result = await this.loadtestService.resetRtbState(dto, resetToken);

    return successResponse(result, 'RTB loadtest 상태를 초기화했습니다.');
  }
}
