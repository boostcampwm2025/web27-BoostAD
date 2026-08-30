import { MODULE_METADATA } from '@nestjs/common/constants';
import { QueueModule } from 'src/queue/queue.module';
import { MLEngine } from 'src/rtb/ml/mlEngine.interface';

jest.mock('src/rtb/ml/xenova-mlEngine', () => ({
  XenovaMLEngine: class XenovaMLEngine {},
}));

import { EmbeddingWorker } from './embedding.worker';
import { EmbeddingWorkerModule } from './embedding-worker.module';
import { RedisTTLWorker } from './redis-ttl.worker';
import { ReservationWorkerModule } from './reservation-worker.module';

type ProviderDefinition =
  | object
  | (new (...args: never[]) => unknown)
  | undefined;

function providersOf(module: object): ProviderDefinition[] {
  return (
    (Reflect.getMetadata(
      MODULE_METADATA.PROVIDERS,
      module
    ) as ProviderDefinition[]) ?? []
  );
}

function importsOf(module: object): unknown[] {
  return (
    (Reflect.getMetadata(MODULE_METADATA.IMPORTS, module) as unknown[]) ?? []
  );
}

function providesToken(providers: ProviderDefinition[], token: unknown) {
  return providers.some(
    (provider) =>
      provider === token ||
      (typeof provider === 'object' &&
        provider !== null &&
        'provide' in provider &&
        provider.provide === token)
  );
}

describe('worker runtime module boundaries', () => {
  it('keeps embedding consumption out of the reservation runtime', () => {
    const embeddingProviders = providersOf(EmbeddingWorkerModule);
    const reservationProviders = providersOf(ReservationWorkerModule);

    expect(providesToken(embeddingProviders, EmbeddingWorker)).toBe(true);
    expect(providesToken(embeddingProviders, MLEngine)).toBe(true);
    expect(providesToken(embeddingProviders, RedisTTLWorker)).toBe(false);

    expect(providesToken(reservationProviders, RedisTTLWorker)).toBe(true);
    expect(providesToken(reservationProviders, EmbeddingWorker)).toBe(false);
    expect(providesToken(reservationProviders, MLEngine)).toBe(false);
  });

  it('does not connect the reservation runtime to BullMQ', () => {
    const reservationImports = importsOf(ReservationWorkerModule);

    expect(reservationImports).not.toContain(QueueModule);
  });
});
