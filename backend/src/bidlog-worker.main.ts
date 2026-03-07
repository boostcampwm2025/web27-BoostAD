import { NestFactory } from '@nestjs/core';
import { BidlogWorkerAppModule } from './bidlogworker/bidlog-worker.app.module';

async function bootstrap() {
  try {
    const app = await NestFactory.createApplicationContext(
      BidlogWorkerAppModule
    );
    app.enableShutdownHooks();
    console.log('BidLog Worker 부트스트랩 성공');
  } catch (error) {
    console.error('BidLog Worker 부트스트랩 실패:', error);
    process.exit(1);
  }
}

void bootstrap();
