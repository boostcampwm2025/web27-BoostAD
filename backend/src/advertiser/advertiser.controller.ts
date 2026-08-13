import { Body, Controller, Get, Post, Query, Req } from '@nestjs/common';
import { AdvertiserService } from './advertiser.service';
import { successResponse } from 'src/common/response/success-response';
import { type AuthenticatedRequest } from 'src/types/authenticated-request';
import { KeywordStatsRequestDto } from './dto/keyword-stats-request.dto';
import { ChargeCreditDto, GetCreditHistoryDto } from './dto/credit.dto';

// import { Public } from 'src/auth/decorators/public.decorator';

@Controller('advertiser')
export class AdvertiserController {
  constructor(private readonly advertiserService: AdvertiserService) {}

  @Get('dashboard/stats')
  async getDashboardStats(@Req() req: AuthenticatedRequest) {
    const userId = req.user.userId;

    const stats = await this.advertiserService.getDashboardStats(userId);
    return successResponse(stats, '광고주 대시보드 통계입니다.');
  }

  // TODO: 안쓰이는 엔드포인트 제거
  @Post('credit/charge')
  async chargeCredit(
    @Req() req: AuthenticatedRequest,
    @Body() body: ChargeCreditDto
  ) {
    const { userId } = req.user;
    const { amount } = body;

    const result = await this.advertiserService.chargeCredit(userId, amount);

    return successResponse(
      {
        balanceAfter: result.balanceAfter,
        amount,
        historyId: result.historyId,
      },
      '크레딧이 충전되었습니다'
    );
  }

  @Get('credit/history')
  async getCreditHistory(
    @Req() req: AuthenticatedRequest,
    @Query() query: GetCreditHistoryDto
  ) {
    const { userId } = req.user;
    const limit = query.limit || 20;
    const offset = query.offset || 0;

    const result = await this.advertiserService.getCreditHistory(
      userId,
      limit,
      offset
    );

    return successResponse(result, '크레딧 사용 내역 조회 성공');
  }

  // 테스트 필요
  @Get('keywords/stats')
  async getKeywordStats(
    @Req() req: AuthenticatedRequest,
    @Query() query: KeywordStatsRequestDto
  ) {
    // const userId = 1;
    const userId = req.user.userId;
    const { limit, offset, sortBy, order } = query;

    const result = await this.advertiserService.getKeywordStats(
      userId,
      limit,
      offset,
      sortBy,
      order
    );
    return successResponse(result, '키워드 성과 통계 목록입니다.');
  }
}
