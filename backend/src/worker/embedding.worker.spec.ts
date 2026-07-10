import { MLEngine } from 'src/rtb/ml/mlEngine.interface';
import { CampaignCacheRepository } from 'src/campaign/repository/campaign.cache.repository.interface';
import { EmbeddingWorker } from './embedding.worker';

describe('EmbeddingWorker lifecycle', () => {
  const buildWorker = (modelReady: boolean) => {
    const mlEngine = {
      isReady: jest.fn(() => modelReady),
    } as unknown as MLEngine;
    const repository = {} as CampaignCacheRepository;
    const worker = new EmbeddingWorker(mlEngine, repository);
    const bullWorker = {
      isRunning: jest.fn(() => false),
      run: jest.fn().mockResolvedValue(undefined),
    };

    Object.defineProperty(worker, 'worker', {
      configurable: true,
      value: bullWorker,
    });

    return { worker, bullWorker };
  };

  it('does not consume jobs before the ML model is ready', () => {
    const { worker, bullWorker } = buildWorker(false);

    worker.onApplicationBootstrap();

    expect(bullWorker.run).not.toHaveBeenCalled();
  });

  it('starts once when the model-ready event arrives', () => {
    const { worker, bullWorker } = buildWorker(false);

    worker.onModelReady();
    worker.onModelReady();

    expect(bullWorker.run).toHaveBeenCalledTimes(1);
  });

  it('starts during bootstrap when the model is already ready', () => {
    const { worker, bullWorker } = buildWorker(true);

    worker.onApplicationBootstrap();

    expect(bullWorker.run).toHaveBeenCalledTimes(1);
  });
});
