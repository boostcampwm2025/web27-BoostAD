import { Module } from '@nestjs/common';
import { CampaignModule } from 'src/campaign/campaign.module';
import { QueueModule } from 'src/queue/queue.module';
import { RTBModule } from 'src/rtb/rtb.module';
import { LoadtestController } from './loadtest.controller';
import { LoadtestService } from './loadtest.service';
import { QualityBenchmarkService } from './quality-benchmark.service';

@Module({
  imports: [CampaignModule, QueueModule, RTBModule],
  controllers: [LoadtestController],
  providers: [LoadtestService, QualityBenchmarkService],
})
export class LoadtestModule {}
