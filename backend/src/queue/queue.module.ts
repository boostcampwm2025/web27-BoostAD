import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { EMBEDDING_QUEUE_NAME } from './queue.names';

@Module({
  imports: [
    ConfigModule,
    BullModule.forRootAsync({
      imports: [ConfigModule],
      useFactory: (configService: ConfigService) => ({
        connection: {
          host: configService.get('REDIS_HOST', 'localhost'),
          port: configService.get('REDIS_PORT', 16379),
        },
      }),
      inject: [ConfigService],
    }),
    BullModule.registerQueue(
      {
        name: EMBEDDING_QUEUE_NAME,
      },
      {
        name: 'bidlog-queue',
        defaultJobOptions: {
          removeOnComplete: true,
          removeOnFail: false,
          attempts: 5,
          backoff: {
            type: 'exponential',
            delay: 1000,
          },
        },
      }
    ),
  ],
  exports: [BullModule],
})
export class QueueModule {}
