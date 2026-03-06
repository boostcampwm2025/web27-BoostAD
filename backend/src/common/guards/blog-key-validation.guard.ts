import {
  Injectable,
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  BadRequestException,
  InternalServerErrorException,
  Logger,
} from '@nestjs/common';
import { Request } from 'express';
import { BlogRepository } from '../../blog/repository/blog.repository.interface';
import { BlogCacheRepository } from '../../blog/repository/blog.cache.repository.interface';
import type { BlogEntity } from '../../blog/entities/blog.entity';
import type { CachedBlog } from '../../blog/types/blog.type';
import {
  createRtbPathLogger,
  rtbPathLogsEnabled,
} from '../logging/rtb-path-logger.util';

// Guard에서 첨부하는 blog 정보 (캐시 or DB 엔티티)
export type BlogInfo = BlogEntity | CachedBlog;

export interface BlogKeyValidatedRequest extends Request {
  blog?: BlogInfo;
  visitorId?: string;
}

function normalizeHostname(hostname: string): string {
  const lower = hostname.trim().toLowerCase();
  const withoutTrailingDot = lower.endsWith('.') ? lower.slice(0, -1) : lower;
  return withoutTrailingDot.startsWith('www.')
    ? withoutTrailingDot.slice('www.'.length)
    : withoutTrailingDot;
}

@Injectable()
export class BlogKeyValidationGuard implements CanActivate {
  private readonly logger = createRtbPathLogger(BlogKeyValidationGuard.name);
  private readonly logsEnabled = rtbPathLogsEnabled();

  constructor(
    private readonly blogRepository: BlogRepository,
    private readonly blogCacheRepository: BlogCacheRepository
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context
      .switchToHttp()
      .getRequest<BlogKeyValidatedRequest>();
    const { blogKey, postUrl } = request.body as {
      blogKey?: string;
      postUrl?: string;
    };

    // blogKey 누락 체크
    if (!blogKey) {
      if (this.logsEnabled) {
        this.logger.warn('blogKey 누락된 요청 시도', {
          ip: request.ip,
          url: request.url,
        });
      }
      throw new BadRequestException('blogKey가 필요합니다.');
    }

    if (!postUrl) {
      if (this.logsEnabled) {
        this.logger.warn('postUrl 누락된 요청 시도', {
          ip: request.ip,
          url: request.url,
        });
      }
      throw new BadRequestException('postUrl이 필요합니다.');
    }

    let requestDomain: string;
    try {
      requestDomain = new URL(postUrl).hostname;
    } catch {
      throw new BadRequestException('유효한 postUrl이 필요합니다.');
    }

    // blogKey 검증 (Redis 우선 → DB fallback)
    let blog: BlogInfo | null;
    try {
      // 1. Redis 캐시 우선 조회 (O(1))
      blog = await this.blogCacheRepository.findByBlogKey(blogKey);

      // 2. 캐시 미스 시 DB fallback
      if (!blog) {
        if (this.logsEnabled) {
          this.logger.debug(`blogKey 캐시 미스, DB 조회: ${blogKey}`);
        }
        blog = await this.blogRepository.findByBlogKey(blogKey);
      }
    } catch (error) {
      if (this.logsEnabled) {
        this.logger.error('blogKey 조회 중 오류 발생', {
          blogKey,
          error: error instanceof Error ? error.message : String(error),
        });
      }
      throw new InternalServerErrorException(
        '블로그 정보 조회 중 오류가 발생했습니다.'
      );
    }

    if (!blog) {
      if (this.logsEnabled) {
        this.logger.warn('미등록 blogKey 요청 차단', {
          blogKey,
          ip: request.ip,
          url: request.url,
          timestamp: new Date().toISOString(),
        });
      }
      throw new ForbiddenException(
        '등록되지 않은 blogKey입니다. 관리자에게 문의하세요.'
      );
    }

    const { domain } = blog;
    const normalizedRequestDomain = normalizeHostname(requestDomain);
    const normalizedBlogDomain = normalizeHostname(domain);

    if (normalizedRequestDomain !== normalizedBlogDomain) {
      if (this.logsEnabled) {
        this.logger.warn('blogKey 도메인 불일치', {
          blogKey,
          requestDomain,
          blogDomain: domain,
          normalizedRequestDomain,
          normalizedBlogDomain,
          ip: request.ip,
          url: request.url,
        });
      }
      throw new ForbiddenException(
        '요청 도메인이 blogKey의 도메인과 일치하지 않습니다.'
      );
    }

    const visitorId = request.cookies?.visitor_id as string | undefined;

    if (visitorId) {
      request.visitorId = visitorId;
    }
    // 요청 객체에 blog 정보 첨부 (후속 로직에서 사용 가능)
    request.blog = blog;

    if (this.logsEnabled) {
      this.logger.log(`blogKey 검증 성공: ${blogKey} (${blog.name})`);
    }
    return true;
  }
}
