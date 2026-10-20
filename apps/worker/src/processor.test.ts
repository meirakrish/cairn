import {
  CairnService,
  EMBEDDING_DIMENSIONS,
  IngestService,
  MemoryObjectStore,
  SourceService,
} from '@cairn/core';
import { createTestDbs, createUser, resetDb } from '@cairn/core/testing';
import { fakeEmbedder } from '@meirakrish/llm-kit/testing';
import { UnrecoverableError, type Job } from 'bullmq';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createProcessor } from './processor';

const { admin, app } = createTestDbs();
const sources = new SourceService(app.db);
const storage = new MemoryObjectStore();
const quiet = { info: () => {}, error: () => {} };

beforeEach(async () => {
  await resetDb(admin.db);
  storage.objects.clear();
});
afterAll(async () => {
  await admin.close();
  await app.close();
});

function processorWith(fail?: (text: string) => Error | undefined) {
  const embedder = fakeEmbedder({ dimensions: EMBEDDING_DIMENSIONS, fail });
  const cairns = new CairnService(app.db, embedder.model);
  const ingest = new IngestService({ cairns, sources, storage, embedder });
  return { cairns, process: createProcessor(ingest, sources, quiet) };
}

async function uploaded(cairns: CairnService, text: string) {
  const user = await createUser(admin.db);
  const cairn = await cairns.create(user.id, { name: 'C' });
  const data = new TextEncoder().encode(text);
  const source = await sources.create(user.id, cairn.id, {
    kind: 'text',
    filename: 'a.txt',
    mime: 'text/plain',
    size: data.length,
  });
  await storage.put(source.storageKey, data, 'text/plain');
  return { userId: user.id, sourceId: source.id };
}

const job = (data: { userId: string; sourceId: string }, attemptsMade = 0) =>
  ({ data, attemptsMade, opts: { attempts: 3 } }) as unknown as Job<typeof data>;

describe('ingest job processor', () => {
  it('processes the source', async () => {
    const { cairns, process } = processorWith();
    const data = await uploaded(cairns, 'hello');

    expect(await process(job(data))).toEqual({ status: 'ready', chunks: 1 });
  });

  it('fails the source at once on a problem with the file, without retries', async () => {
    const { cairns, process } = processorWith();
    const data = await uploaded(cairns, '   ');

    await expect(process(job(data))).rejects.toBeInstanceOf(UnrecoverableError);
    expect(await sources.get(data.userId, data.sourceId)).toMatchObject({
      status: 'failed',
      error: 'no text found in the file',
    });
  });

  it('retries other errors, failing the source only after the last attempt', async () => {
    const { cairns, process } = processorWith(
      () => new Error('connect ECONNREFUSED 172.19.208.1:11434'),
    );
    const data = await uploaded(cairns, 'hello');

    await expect(process(job(data, 0))).rejects.not.toBeInstanceOf(UnrecoverableError);
    expect((await sources.get(data.userId, data.sourceId))?.status).toBe('processing');

    await expect(process(job(data, 2))).rejects.toThrow(/ECONNREFUSED/);
    const failed = await sources.get(data.userId, data.sourceId);
    expect(failed).toMatchObject({ status: 'failed' });
    // The user sees a plain message, not the internal address.
    expect(failed?.error).not.toMatch(/172\.19|ECONNREFUSED/);
  });
});
