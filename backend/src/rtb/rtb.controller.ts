import { Controller, Post, Body, UseGuards, Res, Req } from '@nestjs/common';
import { RTBService } from './rtb.service';
import { plainToInstance } from 'class-transformer';

import { RTBRequestDto } from './dto/rtb-request.dto';
import { RTBResponseDto } from './dto/rtb-response.dto';
import type { DecisionContext } from './types/decision.types';

import { Logger } from '@nestjs/common';
import {
  BlogKeyValidationGuard,
  type BlogKeyValidatedRequest,
} from '../common/guards/blog-key-validation.guard';
import { Public } from '../auth/decorators/public.decorator';
import { type Response } from 'express';
import { randomUUID } from 'crypto';
import { MetricsService } from '../metrics/metrics.service';

@Controller('sdk')
@Public()
@UseGuards(BlogKeyValidationGuard)
export class RTBController {
  private readonly logger = new Logger(RTBController.name);

  constructor(
    private readonly rtbService: RTBService,
    private readonly metricsService: MetricsService
  ) {}

  @Post('decision')
  async getDecision(
    @Body() body: RTBRequestDto,
    @Req() req: BlogKeyValidatedRequest,
    @Res({ passthrough: true }) res: Response
  ) {
    const requestPayloadBytes = Buffer.byteLength(JSON.stringify(body), 'utf8');
    this.metricsService.observeRtbPayload('request', requestPayloadBytes);

    const visitorId = req.visitorId;

    if (!visitorId) {
      res.cookie('visitor_id', randomUUID(), {
        httpOnly: true,
        secure: true,
        sameSite: 'none',
        maxAge: 1000 * 60 * 60 * 24 * 365, // 1년
        path: '/',
      });
    }

    const context: DecisionContext = {
      blogKey: body.blogKey,
      blogId: req.blog!.id, // Guard에서 이미 검증/조회한 blog 활용
      blogName: req.blog!.name, // Guard에서 조회한 blog name 전달 (SSE 이벤트용 DB 조회 제거)
      tags: body.tags,
      postUrl: body.postUrl,
      behaviorScore: body.behaviorScore,
      isHighIntent: body.isHighIntent,
    };

    const result = await this.rtbService.runAuction(context);

    result.data?.candidates?.forEach((candidate) => {
      const eachCandidateLog = {
        id: candidate.id,
        title: candidate.title.slice(0, 10) + '...',
        tags: candidate.tags,
        score: candidate.score,
      };

      this.logger.log(JSON.stringify(eachCandidateLog));
    });

    // Expose 데코레이터가 붙은 속성만 포함하여 DTO 인스턴스로 변환
    const responseDto = plainToInstance(RTBResponseDto, result, {
      excludeExtraneousValues: true,
    });

    const responsePayloadBytes = Buffer.byteLength(
      JSON.stringify(responseDto),
      'utf8'
    );
    this.metricsService.observeRtbPayload('response', responsePayloadBytes);

    return responseDto;
  }
}
