import {
  PermanentIngestError,
  type BackfillResult,
  type IngestJob,
  type IngestResult,
  type IngestService,
  type SourceService,
} from '@cairn/core';
import { describeLlmError } from '@meirakrish/llm-kit';
import { UnrecoverableError, type Job } from 'bullmq';

export interface Log {
  info(msg: string): void;
  error(msg: string): void;
}

/**
 * The BullMQ job handler. A table job (the backfill) only reads the stored file for a table; it
 * never fails the source, since the source was fine before and still is. A problem with the file fails the source at once (no retries). Anything else
 * is retried by BullMQ, and the source is marked failed only when the last attempt fails too.
 */
export function createProcessor(ingest: IngestService, sources: SourceService, log: Log = console) {
  return async (job: Job<IngestJob>): Promise<IngestResult | BackfillResult> => {
    const { sourceId, userId } = job.data;
    const attempt = job.attemptsMade + 1;
    const attempts = job.opts.attempts ?? 1;
    const started = Date.now();
    if (job.data.task === 'table') {
      try {
        const result = await ingest.backfillTable(userId, sourceId);
        log.info(
          `source ${sourceId}: table: ${JSON.stringify(result)} in ${Date.now() - started} ms`,
        );
        return result;
      } catch (err) {
        log.error(
          `source ${sourceId}: table attempt ${attempt}/${attempts} failed: ${describeLlmError(err)}`,
        );
        throw err;
      }
    }
    try {
      const result = await ingest.process(userId, sourceId);
      log.info(`source ${sourceId}: ${JSON.stringify(result)} in ${Date.now() - started} ms`);
      return result;
    } catch (err) {
      if (err instanceof PermanentIngestError) {
        log.info(`source ${sourceId}: failed: ${err.message}`);
        await sources.fail(userId, sourceId, err.message);
        throw new UnrecoverableError(err.message);
      }
      log.error(
        `source ${sourceId}: attempt ${attempt}/${attempts} failed: ${describeLlmError(err)}`,
      );
      if (attempt >= attempts) {
        await sources.fail(
          userId,
          sourceId,
          'processing failed after several attempts; try uploading again later',
        );
      }
      throw err;
    }
  };
}
