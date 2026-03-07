import { NestFactory } from '@nestjs/core';
import { BidlogWorkerModule } from './bidlogworker/bidlog-worker.module';

async function bootstrap() {
  try {
    const app = await NestFactory.createApplicationContext(BidlogWorkerModule);
    app.enableShutdownHooks();
    console.log('BidLog Worker 부트스트랩 성공');
  } catch (error) {
    console.error('BidLog Worker 부트스트랩 실패:', error);
    process.exit(1);
  }
}

void bootstrap();
