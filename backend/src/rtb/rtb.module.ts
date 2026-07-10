// src/rtb/rtb.module.ts

import { Module } from '@nestjs/common';
import { RTBService } from './rtb.service';

import { CampaignModule } from '../campaign/campaign.module';

// MLEngine
import { MLEngine } from './ml/mlEngine.interface';
import { XenovaMLEngine } from './ml/xenova-mlEngine';
import { RequestEmbeddingCacheService } from './ml/request-embedding-cache.service';
import { RedisModule } from '../redis/redis.module';
import { ContextEmbeddingService } from './context/context-embedding.service';

// Matcher
import { Matcher } from './matchers/matcher.interface';
// import { PrototypeMatcher } from './matchers/prototype.matcher';
import { TransformerMatcher } from './matchers/xenova.matcher';

// Scorer
import { Scorer } from './scorers/scorer.interface';
// import { PrototypeScorer } from './scorers/prototype.scorer';
import { TransformerScorer } from './scorers/xenova.scorer';

// Selector
import { CampaignSelector } from './selectors/selector.interface';
import { PrototypeCampaignSelector } from './selectors/prototype.selector';

// controller
import { RTBController } from './rtb.controller';

// Cache (AuctionStore 사용을 위해)
import { CacheModule } from '../cache/cache.module';

import { BidLogModule } from '../bid-log/bid-log.module';

import { BlogModule } from '../blog/blog.module';
import { MetricsModule } from '../metrics/metrics.module';

import { QueueModule } from '../queue/queue.module';

@Module({
  imports: [
    CacheModule,
    BidLogModule,
    CampaignModule,
    BlogModule,
    MetricsModule,
    QueueModule,
    RedisModule,
  ],
  controllers: [RTBController],
  providers: [
    RTBService,
    RequestEmbeddingCacheService,
    ContextEmbeddingService,

    // Matcher
    {
      provide: Matcher,
      useClass: TransformerMatcher,
    },

    // Scorer
    {
      provide: Scorer,
      useClass: TransformerScorer,
    },

    // Selector
    {
      provide: CampaignSelector,
      useClass: PrototypeCampaignSelector,
    },

    // MLEngine,
    {
      provide: MLEngine,
      useClass: XenovaMLEngine,
    },
  ],
  exports: [
    RTBService,
    MLEngine,
    RequestEmbeddingCacheService,
    ContextEmbeddingService,
  ],
})
export class RTBModule {}
