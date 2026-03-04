import {
  BadRequestException,
  Body,
  Controller,
  HttpCode,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { SdkService } from './sdk.service';
import { CreateViewLogDto } from './dto/create-view-log.dto';
import { successResponse } from 'src/common/response/success-response';
import { CreateClickLogDto } from './dto/create-click-log.dto';
import { CreateDismissLogDto } from './dto/create-dismiss-log.dto';
import { Public } from 'src/auth/decorators/public.decorator';
import {
  type BlogKeyValidatedRequest,
  BlogKeyValidationGuard,
} from 'src/common/guards/blog-key-validation.guard';

@Controller('sdk')
export class SdkController {
  constructor(private readonly sdkService: SdkService) {}

  //TODO: decision API 호출 수 만큼 뷰로그 생성 요청이 보내지므로 DB요청도 선형적으로 증가하게됨
  @Public()
  @UseGuards(BlogKeyValidationGuard)
  @Post('campaign-view')
  async recordView(
    @Body() createViewLogDto: CreateViewLogDto,
    @Req() req: BlogKeyValidatedRequest
  ) {
    const { visitorId } = req;

    if (!visitorId) {
      throw new BadRequestException('비정상적인 API 요청입니다.');
    }

    const viewId = await this.sdkService.recordView(
      createViewLogDto,
      visitorId
    );
    return successResponse(
      { viewId },
      '캠페인 노출 로그가 성공적으로 저장되었습니다.'
    );
  }

  @Public()
  @UseGuards(BlogKeyValidationGuard)
  @Post('campaign-click')
  async recordClick(
    @Body() createClickLogDto: CreateClickLogDto,
    @Req() req: BlogKeyValidatedRequest
  ) {
    const { visitorId } = req;
    if (!visitorId) {
      throw new BadRequestException('비정상적인 API 요청입니다.');
    }
    const clickId = await this.sdkService.recordClick(createClickLogDto);
    return successResponse(
      { clickId },
      '캠페인 클릭 로그가 성공적으로 저장되었습니다.'
    );
  }

  @Public()
  @UseGuards(BlogKeyValidationGuard)
  @Post('campaign-dismiss')
  @HttpCode(204)
  async recordDismiss(@Body() createDismissLogDto: CreateDismissLogDto) {
    await this.sdkService.recordDismiss(createDismissLogDto);
  }
}
