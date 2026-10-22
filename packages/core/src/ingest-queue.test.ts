import { describe, expect, it } from 'vitest';
import { ingestJobId } from './ingest-queue';

describe('ingestJobId', () => {
  it('gives a source one id per task, with no colon (BullMQ refuses them)', () => {
    const job = { sourceId: 'abc', userId: 'u' };

    expect(ingestJobId(job)).toBe('abc');
    expect(ingestJobId({ ...job, task: 'table' })).toBe('table-abc');
    expect(ingestJobId({ ...job, task: 'table' })).not.toContain(':');
  });
});
