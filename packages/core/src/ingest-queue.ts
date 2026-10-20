import { Queue } from 'bullmq';
import type { Redis } from 'ioredis';

export const INGEST_QUEUE = 'ingest';

/** The worker processes the source as `userId` (the uploader), so RLS applies to it too. */
export interface IngestJob {
  sourceId: string;
  userId: string;
}

export class IngestQueue {
  readonly queue: Queue<IngestJob>;

  constructor(connection: Redis) {
    this.queue = new Queue<IngestJob>(INGEST_QUEUE, {
      connection,
      defaultJobOptions: {
        attempts: 3,
        backoff: { type: 'exponential', delay: 5_000 },
        removeOnComplete: 1_000,
        removeOnFail: 5_000,
      },
    });
  }

  /** One job per source: the source id is the job id, so a repeated enqueue is a no-op. */
  async enqueue(job: IngestJob): Promise<void> {
    await this.queue.add('ingest', job, { jobId: job.sourceId });
  }

  /** Drops a waiting job. A job already running finds its source gone and stops. */
  async remove(sourceId: string): Promise<void> {
    await this.queue.remove(sourceId);
  }

  close(): Promise<void> {
    return this.queue.close();
  }
}
