import { NestFactory } from '@nestjs/core';
import { ReservationWorkerModule } from './worker/reservation-worker.module';

async function bootstrap() {
  try {
    const app = await NestFactory.createApplicationContext(
      ReservationWorkerModule
    );
    app.enableShutdownHooks();
    console.log('Reservation Worker 부트스트랩 성공');
  } catch (error) {
    console.error('Reservation Worker 부트스트랩 실패:', error);
    process.exit(1);
  }
}

void bootstrap();
