import { MetricsService } from './metrics.service';

describe('MetricsService', () => {
  it('exports bidlog queue job counts into the registry before scrape', async () => {
    const queue = {
      name: 'bidlog-queue',
      getJobCounts: jest.fn().mockResolvedValue({
        waiting: 7,
        active: 2,
        delayed: 1,
        prioritized: 0,
        paused: 0,
        completed: 11,
        failed: 3,
      }),
    };

    const service = new MetricsService(queue as never);

    const metrics = await service.getMetrics();

    expect(queue.getJobCounts).toHaveBeenCalledWith(
      'waiting',
      'active',
      'delayed',
      'prioritized',
      'paused',
      'completed',
      'failed'
    );
    expect(metrics).toContain(
      'boostad_queue_jobs{queue="bidlog-queue",state="waiting"} 7'
    );
    expect(metrics).toContain(
      'boostad_queue_jobs{queue="bidlog-queue",state="active"} 2'
    );
    expect(metrics).toContain(
      'boostad_queue_jobs{queue="bidlog-queue",state="failed"} 3'
    );
  });
});
