import { fakeEmbedder, scriptedLlm } from '@meirakrish/llm-kit/testing';
import sharp from 'sharp';
import { ContextOverflowError, type LlmClient } from '@meirakrish/llm-kit';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { CairnService } from '../cairns';
import { EMBEDDING_DIMENSIONS, type SourceKind } from '../db';
import { SourceService } from '../sources';
import { MemoryObjectStore } from '../storage';
import { createTestDbs, createUser, makePdf, resetDb } from '../testing';
import { PermanentIngestError } from './errors';
import { PAGE_PROMPT } from './image';
import { IngestService } from './service';

const { admin, app } = createTestDbs();
const sources = new SourceService(app.db);
const storage = new MemoryObjectStore();

beforeEach(async () => {
  await resetDb(admin.db);
  storage.objects.clear();
});
afterAll(async () => {
  await admin.close();
  await app.close();
});

function setup(embedder = fakeEmbedder({ dimensions: EMBEDDING_DIMENSIONS }), vision?: LlmClient) {
  const cairns = new CairnService(app.db, embedder.model);
  const ingest = new IngestService({
    cairns,
    sources,
    storage,
    embedder,
    vision,
    chunking: { maxChars: 200, overlapChars: 40 },
  });
  return { cairns, ingest, embedder };
}

async function uploaded(cairns: CairnService, kind: SourceKind, data: Uint8Array) {
  const user = await createUser(admin.db);
  const cairn = await cairns.create(user.id, { name: 'C' });
  const mimes: Record<SourceKind, string> = {
    text: 'text/plain',
    markdown: 'text/markdown',
    pdf: 'application/pdf',
    csv: 'text/csv',
    json: 'application/json',
    image: 'image/png',
  };
  const mime = mimes[kind];
  const source = await sources.create(user.id, cairn.id, {
    kind,
    filename: 'f',
    mime,
    size: data.length,
  });
  await storage.put(source.storageKey, data, mime);
  return { user, source };
}

const utf8 = (s: string) => new TextEncoder().encode(s);

describe('IngestService', () => {
  it('extracts, chunks, embeds and stores a Markdown file', async () => {
    const { cairns, ingest, embedder } = setup();
    const md = '# Trails\nCairns mark the route.\n\n## Safety\n' + 'Stay on the path. '.repeat(20);
    const { user, source } = await uploaded(cairns, 'markdown', utf8(md));

    const result = await ingest.process(user.id, source.id);

    const chunks = await sources.listChunks(user.id, source.id);
    expect(result).toEqual({ status: 'ready', chunks: chunks.length });
    expect(chunks.length).toBeGreaterThan(2);
    expect(chunks[0]).toMatchObject({ ordinal: 0, location: { headings: ['Trails'] } });
    expect(chunks.at(-1)?.location).toEqual({ headings: ['Trails', 'Safety'] });
    expect(embedder.calls.flat()).toEqual(chunks.map((c) => c.content));
    expect((await sources.get(user.id, source.id))?.status).toBe('ready');
  });

  it('stores CSV rows in whole-row chunks with their row ranges', async () => {
    const { cairns, ingest } = setup();
    const rows = Array.from(
      { length: 60 },
      (_, i) => `T-${i},${'trail '.repeat(8).trim()},${i * 10}`,
    );
    const { user, source } = await uploaded(
      cairns,
      'csv',
      utf8(['id,route,length', ...rows].join('\n')),
    );

    await ingest.process(user.id, source.id);
    const chunks = await sources.listChunks(user.id, source.id);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks[0]!.content.split('\n')[0]).toBe(
      'id: T-0; route: trail trail trail trail trail trail trail trail; length: 0',
    );
    expect(chunks[0]!.location.rows![0]).toBe(2);
    expect(chunks.at(-1)!.location.rows![1]).toBe(61);
    for (const c of chunks) expect(c.content.length).toBeLessThanOrEqual(200);
  });

  it('stores the vision model’s description of an image', async () => {
    const vision = scriptedLlm({
      stream: [['Text in the image:\nGate code 7319\n\n', 'Description:\nA trail sign.']],
    });
    const { cairns, ingest } = setup(undefined, vision);
    const png = await sharp({
      create: { width: 40, height: 20, channels: 3, background: '#888888' },
    })
      .png()
      .toBuffer();
    const { user, source } = await uploaded(cairns, 'image', png);

    expect(await ingest.process(user.id, source.id)).toEqual({ status: 'ready', chunks: 1 });
    const [chunk] = await sources.listChunks(user.id, source.id);
    expect(chunk).toMatchObject({
      content: 'Text in the image:\nGate code 7319\n\nDescription:\nA trail sign.',
      location: {},
    });
    expect(vision.calls).toHaveLength(1);
  });

  it('fails images permanently without a vision model, or when unreadable', async () => {
    const { cairns, ingest } = setup();
    const { user, source } = await uploaded(cairns, 'image', utf8('not really a png'));
    await expect(ingest.process(user.id, source.id)).rejects.toThrow(/need a vision model/);

    const withVision = setup(undefined, scriptedLlm());
    const broken = await uploaded(withVision.cairns, 'image', utf8('not really a png'));
    await expect(withVision.ingest.process(broken.user.id, broken.source.id)).rejects.toThrow(
      PermanentIngestError,
    );
  });

  it('reads scanned PDF pages with the vision model', async () => {
    const vision = scriptedLlm({ stream: [['Minutes of the trail committee, page two.']] });
    const { cairns, ingest } = setup(undefined, vision);
    const text = 'The first page has a proper text layer, long enough to count as text.';
    const { user, source } = await uploaded(cairns, 'pdf', makePdf([text, '']));

    await ingest.process(user.id, source.id);
    const chunks = await sources.listChunks(user.id, source.id);
    expect(chunks.map((c) => [c.location.page, c.content])).toEqual([
      [1, text],
      [2, 'Minutes of the trail committee, page two.'],
    ]);
    const prompt = String(vision.calls[0]!.messages[0]!.content);
    expect(prompt).toBe(PAGE_PROMPT);
  });

  it('keeps PDF page numbers', async () => {
    const { cairns, ingest } = setup();
    const { user, source } = await uploaded(cairns, 'pdf', makePdf(['First page', 'Second page']));

    await ingest.process(user.id, source.id);
    expect((await sources.listChunks(user.id, source.id)).map((c) => c.location)).toEqual([
      { page: 1 },
      { page: 2 },
    ]);
  });

  it('skips sources that are already ready or deleted', async () => {
    const { cairns, ingest, embedder } = setup();
    const { user, source } = await uploaded(cairns, 'text', utf8('hello'));
    await ingest.process(user.id, source.id);

    expect(await ingest.process(user.id, source.id)).toEqual({
      status: 'skipped',
      reason: 'already ready',
    });
    await sources.delete(user.id, source.id);
    expect(await ingest.process(user.id, source.id)).toEqual({ status: 'skipped', reason: 'gone' });
    expect(embedder.calls).toHaveLength(1);
  });

  it('runs as the uploader: another user cannot process the source', async () => {
    const { cairns, ingest } = setup();
    const { source } = await uploaded(cairns, 'text', utf8('hello'));
    const other = await createUser(admin.db);

    expect(await ingest.process(other.id, source.id)).toEqual({
      status: 'skipped',
      reason: 'gone',
    });
  });

  it('fails permanently on files without text, missing files and a different embedding model', async () => {
    const { cairns, ingest } = setup();
    const empty = await uploaded(cairns, 'text', utf8('   \n\n  '));
    await expect(ingest.process(empty.user.id, empty.source.id)).rejects.toThrow(/no text found/);

    const missing = await uploaded(cairns, 'text', utf8('hello'));
    storage.objects.clear();
    await expect(ingest.process(missing.user.id, missing.source.id)).rejects.toThrow(
      /file is missing/,
    );

    const other = setup(fakeEmbedder({ dimensions: EMBEDDING_DIMENSIONS }));
    const mismatch = await uploaded(new CairnService(app.db, 'old-model'), 'text', utf8('hello'));
    const err = await other.ingest
      .process(mismatch.user.id, mismatch.source.id)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PermanentIngestError);
    expect((err as Error).message).toMatch(/uses the embedding model old-model/);
  });

  it('turns an embedding context overflow into a permanent error', async () => {
    const embedder = fakeEmbedder({
      dimensions: EMBEDDING_DIMENSIONS,
      fail: () => new ContextOverflowError(9000, 8192),
    });
    const { cairns, ingest } = setup(embedder);
    const { user, source } = await uploaded(cairns, 'text', utf8('hello'));

    await expect(ingest.process(user.id, source.id)).rejects.toThrow(
      /too long for the embedding model/,
    );
  });

  it('lets other embedder errors through for a retry, leaving the source processing', async () => {
    const embedder = fakeEmbedder({
      dimensions: EMBEDDING_DIMENSIONS,
      fail: () => new Error('fetch failed'),
    });
    const { cairns, ingest } = setup(embedder);
    const { user, source } = await uploaded(cairns, 'text', utf8('hello'));

    const err = await ingest.process(user.id, source.id).catch((e: unknown) => e);
    expect(err).not.toBeInstanceOf(PermanentIngestError);
    expect((await sources.get(user.id, source.id))?.status).toBe('processing');
  });
});
