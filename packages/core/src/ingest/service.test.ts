import { fakeEmbedder, scriptedLlm } from '@meirakrish/llm-kit/testing';
import sharp from 'sharp';
import { ContextOverflowError, type LlmClient } from '@meirakrish/llm-kit';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { CairnService } from '../cairns';
import { EMBEDDING_DIMENSIONS, sourceRows, withUser, type SourceKind } from '../db';
import { SourceService } from '../sources';
import { LlmModerator } from '../moderation';
import { MemoryObjectStore } from '../storage';
import { createTestDbs, createUser, makePdf, resetDb } from '../testing';
import type { FetchedPage } from '../web';
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

function setup(
  embedder = fakeEmbedder({ dimensions: EMBEDDING_DIMENSIONS }),
  vision?: LlmClient,
  fetchPage?: (url: string) => Promise<FetchedPage>,
  moderator?: LlmModerator,
) {
  const cairns = new CairnService(app.db, embedder.model);
  const ingest = new IngestService({
    cairns,
    sources,
    storage,
    embedder,
    vision,
    fetchPage,
    moderator,
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
    // As a site sends it; the charset matters for web pages.
    web: 'text/html; charset=windows-1252',
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

  it('stores the rows and column types of a CSV', async () => {
    const { cairns, ingest } = setup();
    const { user, source } = await uploaded(cairns, 'csv', utf8('route,km\nNorth,12\nSouth,7.5'));

    await ingest.process(user.id, source.id);
    const stored = await sources.get(user.id, source.id);
    expect(stored?.columns).toEqual([
      { name: 'route', type: 'text' },
      { name: 'km', type: 'number' },
    ]);
    const rows = () =>
      withUser(app.db, user.id, (tx) => tx.select().from(sourceRows).orderBy(sourceRows.row));
    expect((await rows()).map((r) => [r.row, r.data])).toEqual([
      [2, { route: 'North', km: 12 }],
      [3, { route: 'South', km: 7.5 }],
    ]);
  });

  it('keeps no rows for text, nested JSON or a CSV with only a header', async () => {
    const { cairns, ingest } = setup();
    for (const [kind, text] of [
      ['text', 'hello'],
      ['json', '{"a":{"b":1}}'],
      ['csv', 'a,b\n'],
    ] as const) {
      const { user, source } = await uploaded(cairns, kind, utf8(text));
      await ingest.process(user.id, source.id).catch(() => undefined);
      expect((await sources.get(user.id, source.id))?.columns).toBeNull();
    }
    expect(await admin.db.select().from(sourceRows)).toEqual([]);
  });

  it('stores a web page as heading sections, decoded with its charset', async () => {
    const { cairns, ingest } = setup();
    const html = '<title>Hut</title><h2>Hours</h2><p>The caf\xe9 opens at 9.</p>';
    const { user, source } = await uploaded(
      cairns,
      'web',
      Uint8Array.from(html, (c) => c.charCodeAt(0)),
    );

    await ingest.process(user.id, source.id);
    const chunks = await sources.listChunks(user.id, source.id);
    expect(chunks.map((c) => [c.content, c.location])).toEqual([
      ['## Hours\n\nThe café opens at 9.', { headings: ['Hours'] }],
    ]);
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

  describe('web sources', () => {
    /** A fake site: URL → page, recording what was fetched. */
    function site(pages: Record<string, Omit<FetchedPage, 'url'> | Error>) {
      const fetched: string[] = [];
      const fetchPage = async (url: string) => {
        fetched.push(url);
        const page = pages[url];
        if (!page) throw new PermanentIngestError('the site answered 404');
        if (page instanceof Error) throw page;
        return { url, ...page };
      };
      return { fetched, fetchPage };
    }

    async function added(cairns: CairnService, url: string) {
      const user = await createUser(admin.db);
      const cairn = await cairns.create(user.id, { name: 'C' });
      const source = await sources.create(user.id, cairn.id, {
        kind: 'web',
        filename: url,
        mime: 'text/html',
        size: 0,
        url,
      });
      return { user, source };
    }

    const html = (title: string, body: string) =>
      utf8(
        `<html><head><title>${title}</title></head><body><h2>Hours</h2><p>${body}</p></body></html>`,
      );

    it('fetches the page, keeps a snapshot, and names the source after its title', async () => {
      const page = html('Hut info', 'The hut opens at 9.');
      const { fetchPage, fetched } = site({
        'https://example.com/hut': { contentType: 'text/html; charset=utf-8', data: page },
      });
      const { cairns, ingest } = setup(undefined, undefined, fetchPage);
      const { user, source } = await added(cairns, 'https://example.com/hut');

      expect(await ingest.process(user.id, source.id)).toEqual({ status: 'ready', chunks: 1 });
      expect(fetched).toEqual(['https://example.com/hut']);
      expect(await sources.get(user.id, source.id)).toMatchObject({
        kind: 'web',
        filename: 'Hut info',
        mime: 'text/html; charset=utf-8',
        size: page.length,
        url: 'https://example.com/hut',
        status: 'ready',
      });
      expect(storage.objects.get(source.storageKey)?.body).toEqual(page);
      expect((await sources.listChunks(user.id, source.id)).map((c) => c.location)).toEqual([
        { headings: ['Hours'] },
      ]);
    });

    it('reads a URL that serves another kind of file like an upload', async () => {
      const { fetchPage } = site({
        'https://example.com/files/minutes.pdf': {
          contentType: 'application/octet-stream',
          data: makePdf(['Minutes of the meeting']),
        },
        'https://example.com/api/trails': {
          contentType: 'application/json; charset=utf-8',
          data: utf8('{"trails":[{"id":1,"name":"Ridge"},{"id":2,"name":"Lake"}]}'),
        },
      });
      const { cairns, ingest } = setup(undefined, undefined, fetchPage);

      const pdf = await added(cairns, 'https://example.com/files/minutes.pdf');
      await ingest.process(pdf.user.id, pdf.source.id);
      expect(await sources.get(pdf.user.id, pdf.source.id)).toMatchObject({
        kind: 'pdf',
        mime: 'application/pdf',
        filename: 'example.com/files/minutes.pdf',
        status: 'ready',
      });

      const json = await added(cairns, 'https://example.com/api/trails');
      await ingest.process(json.user.id, json.source.id);
      expect(await sources.get(json.user.id, json.source.id)).toMatchObject({ kind: 'json' });
    });

    it('fails permanently for unreadable types and pages without text, keeping what was fetched', async () => {
      const { fetchPage } = site({
        'https://example.com/app': {
          contentType: 'text/html',
          data: utf8('<title>App</title><div id="root"></div><script src="a.js"></script>'),
        },
        'https://example.com/song.mp3': { contentType: 'audio/mpeg', data: new Uint8Array([0, 1]) },
      });
      const { cairns, ingest } = setup(undefined, undefined, fetchPage);

      const app_ = await added(cairns, 'https://example.com/app');
      await expect(ingest.process(app_.user.id, app_.source.id)).rejects.toThrow(
        /may need JavaScript/,
      );
      expect(await sources.get(app_.user.id, app_.source.id)).toMatchObject({
        filename: 'example.com/app',
        size: expect.any(Number) as number,
      });

      const song = await added(cairns, 'https://example.com/song.mp3');
      const err = await ingest.process(song.user.id, song.source.id).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(PermanentIngestError);
      expect((err as Error).message).toBe("the URL serves a file Cairn can't read (audio/mpeg)");
    });

    it('lets fetch errors through: permanent ones fail, others are retried', async () => {
      const { fetchPage } = site({
        'https://example.com/busy': new Error('the site answered 503'),
      });
      const { cairns, ingest } = setup(undefined, undefined, fetchPage);
      const busy = await added(cairns, 'https://example.com/busy');
      const err = await ingest.process(busy.user.id, busy.source.id).catch((e: unknown) => e);
      expect(err).not.toBeInstanceOf(PermanentIngestError);
      const gone = await added(cairns, 'https://example.com/gone');
      await expect(ingest.process(gone.user.id, gone.source.id)).rejects.toThrow(
        PermanentIngestError,
      );
    });

    it('fails permanently without a fetcher', async () => {
      const { cairns, ingest } = setup();
      const { user, source } = await added(cairns, 'https://example.com/');
      await expect(ingest.process(user.id, source.id)).rejects.toThrow(/cannot fetch web pages/);
    });

    it('replaces the chunks and name when a refreshed page is fetched again', async () => {
      const pages = {
        'https://example.com/hut': { contentType: 'text/html', data: html('Hut', 'Opens at 9.') },
      };
      const { fetchPage } = site(pages);
      const { cairns, ingest } = setup(undefined, undefined, fetchPage);
      const { user, source } = await added(cairns, 'https://example.com/hut');
      await ingest.process(user.id, source.id);

      // Ready sources are skipped until refreshed; uploads can't be refreshed.
      pages['https://example.com/hut'].data = html('Hut (winter)', 'Opens at 10.');
      expect((await ingest.process(user.id, source.id)).status).toBe('skipped');
      expect((await sources.requeue(user.id, source.id))?.status).toBe('pending');
      await ingest.process(user.id, source.id);

      expect((await sources.get(user.id, source.id))?.filename).toBe('Hut (winter)');
      const chunks = await sources.listChunks(user.id, source.id);
      expect(chunks.map((c) => c.content)).toEqual(['## Hours\n\nOpens at 10.']);

      const file = await uploaded(cairns, 'text', utf8('hello'));
      await ingest.process(file.user.id, file.source.id);
      expect(await sources.requeue(file.user.id, file.source.id)).toBeUndefined();
    });
  });
});

describe('IngestService moderation', () => {
  it('stores text the moderator allows, after checking all of it', async () => {
    const llm = scriptedLlm({ structured: () => ({ category: 'none' }) });
    const { cairns, ingest } = setup(undefined, undefined, undefined, new LlmModerator(llm));
    const { user, source } = await uploaded(cairns, 'text', utf8('Cairns mark the route.'));

    expect(await ingest.process(user.id, source.id)).toMatchObject({ status: 'ready' });
    expect(llm.calls).toHaveLength(1);
    expect(String(llm.calls[0]!.messages[1]!.content)).toContain('Cairns mark the route.');
  });

  it('rejects blocked text: no chunks, no embedding, stored file deleted', async () => {
    const llm = scriptedLlm({ structured: [{ category: 'violence' }] });
    const embedder = fakeEmbedder({ dimensions: EMBEDDING_DIMENSIONS });
    const { cairns, ingest } = setup(embedder, undefined, undefined, new LlmModerator(llm));
    const { user, source } = await uploaded(cairns, 'text', utf8('Something awful.'));

    expect(await ingest.process(user.id, source.id)).toEqual({
      status: 'rejected',
      category: 'violence',
    });
    expect(await sources.get(user.id, source.id)).toMatchObject({
      status: 'rejected',
      error: 'Not added: it contains graphic violence',
    });
    expect(await sources.listChunks(user.id, source.id)).toEqual([]);
    expect(embedder.calls).toEqual([]);
    expect(storage.objects.has(source.storageKey)).toBe(false);
    // A late duplicate job leaves it rejected.
    expect(await ingest.process(user.id, source.id)).toMatchObject({ status: 'skipped' });
  });

  it('checks what the vision model read from an image', async () => {
    const png = await sharp({
      create: { width: 8, height: 8, channels: 3, background: '#888' },
    })
      .png()
      .toBuffer();
    const vision = scriptedLlm({ stream: [['A detailed picture of gore.']] });
    const llm = scriptedLlm({ structured: [{ category: 'violence' }] });
    const { cairns, ingest } = setup(undefined, vision, undefined, new LlmModerator(llm));
    const { user, source } = await uploaded(cairns, 'image', png);

    expect(await ingest.process(user.id, source.id)).toMatchObject({ status: 'rejected' });
    expect(String(llm.calls[0]!.messages[1]!.content)).toContain('A detailed picture of gore.');
  });

  it('lets model errors through for a retry, leaving the source processing', async () => {
    const llm = scriptedLlm({ structured: [new Error('ollama down')] });
    const { cairns, ingest } = setup(undefined, undefined, undefined, new LlmModerator(llm));
    const { user, source } = await uploaded(cairns, 'text', utf8('Fine text.'));

    await expect(ingest.process(user.id, source.id)).rejects.toThrow('ollama down');
    expect((await sources.get(user.id, source.id))?.status).toBe('processing');
  });
});
