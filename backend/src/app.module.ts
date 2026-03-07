import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ScheduleModule } from '@nestjs/schedule';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { getTypeOrmConfig } from './config/typeorm.config';
// import { ThrottlerModule, ThrottlerGuard } from '@nestjs/throttler';
import { APP_GUARD } from '@nestjs/core';
import { RTBModule } from './rtb/rtb.module';
import { BidLogModule } from './bid-log/bid-log.module';
import { SdkModule } from './sdk/sdk.module';
import { AdvertiserModule } from './advertiser/advertiser.module';
import { LogModule } from './log/log.module';
import { CacheModule } from './cache/cache.module';
import { CampaignModule } from './campaign/campaign.module';
import { UserModule } from './user/user.module';
import { AuthModule } from './auth/auth.module';
import { JwtCookieGuard } from './auth/guards/jwt-cookie.guard';
import { BlogModule } from './blog/blog.module';
import { ImageModule } from './image/image.module';
import { RedisModule } from './redis/redis.module';
import { PaymentModule } from './payment/payment.module';
import { PublisherModule } from './publisher/publisher.module';
import { MetricsModule } from './metrics/metrics.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    EventEmitterModule.forRoot(),
    ScheduleModule.forRoot(),
    // ThrottlerModule.forRoot([
    //   {
    //     ttl: 60000, // 60초
    //     limit: 100, // IP당 100회
    //   },
    // ]),
    RTBModule,

    // 팩토리 함수 사용해서 typeORM 설정 비동기 로드
    TypeOrmModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (configService: ConfigService) =>
        getTypeOrmConfig(configService),
    }),

    BidLogModule,
    SdkModule,
    AdvertiserModule,
    LogModule,
    CacheModule,
    CampaignModule,
    UserModule,
    AuthModule,
    BlogModule,
    ImageModule,
    RedisModule,
    PaymentModule,
    PublisherModule,
    MetricsModule,
    // QueueModule,
  ],
  controllers: [],
  providers: [
    // {
    //   provide: APP_GUARD,
    //   useClass: ThrottlerGuard,
    // },
    {
      provide: APP_GUARD,
      useClass: JwtCookieGuard,
    },
  ],
})
export class AppModule {}
