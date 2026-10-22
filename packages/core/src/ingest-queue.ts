import { Queue } from 'bullmq';
import type { Redis } from 'ioredis';

export const INGEST_QUEUE = 'ingest';

/** The worker processes the source as `userId` (the uploader), so RLS applies to it too. */
export interface IngestJob {
  sourceId: string;
  userId: string;
  /** 'table': only read the stored file for a table (backfill), instead of ingesting the source. */
  task?: 'table';
}

/** BullMQ forbids ':' in custom ids. A source's table job has an id of its own, so it never meets its ingest job. */
export const ingestJobId = (job: IngestJob): string =>
  job.task === 'table' ? `table-${job.sourceId}` : job.sourceId;

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

  /**
   * One job per source and task: the job id is derived from the source id, so a repeated enqueue is
   * a no-op. A table job that failed is dropped first, so running the backfill again retries it.
   */
  async enqueue(job: IngestJob): Promise<void> {
    const jobId = ingestJobId(job);
    if (job.task === 'table') {
      const previous = await this.queue.getJob(jobId);
      if (previous && (await previous.getState()) === 'failed') await previous.remove();
    }
    await this.queue.add('ingest', job, { jobId });
  }

  /** Drops a waiting job. A job already running finds its source gone and stops. */
  async remove(sourceId: string): Promise<void> {
    await this.queue.remove(sourceId);
  }

  close(): Promise<void> {
    return this.queue.close();
  }
}
