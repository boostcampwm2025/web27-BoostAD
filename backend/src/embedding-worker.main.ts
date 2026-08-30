import { NestFactory } from '@nestjs/core';
import { EmbeddingWorkerModule } from './worker/embedding-worker.module';

async function bootstrap() {
  try {
    const app = await NestFactory.createApplicationContext(
      EmbeddingWorkerModule
    );
    app.enableShutdownHooks();
    console.log('Embedding Worker 부트스트랩 성공');
  } catch (error) {
    console.error('Embedding Worker 부트스트랩 실패:', error);
    process.exit(1);
  }
}

void bootstrap();
