import { Module } from '@nestjs/common';
import { CampaignModule } from 'src/campaign/campaign.module';
import { QueueModule } from 'src/queue/queue.module';
import { LoadtestController } from './loadtest.controller';
import { LoadtestService } from './loadtest.service';

@Module({
  imports: [CampaignModule, QueueModule],
  controllers: [LoadtestController],
  providers: [LoadtestService],
})
export class LoadtestModule {}
