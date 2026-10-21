import { randomUUID } from 'node:crypto';
import { sources } from '@cairn/core';
import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { APP_ORIGIN, createTestApp } from './testing';

const t = createTestApp();

beforeEach(() => t.reset());
afterAll(() => t.close());

async function signedInWithCairn() {
  const user = await t.createUser();
  const cookie = await t.signIn(user.id);
  const res = await request(t.app)
    .post('/api/cairns')
    .set('Cookie', cookie)
    .set('Origin', APP_ORIGIN)
    .send({ name: 'Docs' })
    .expect(201);
  return { user, cookie, cairnId: res.body.cairn.id as string };
}

function upload(cookie: string, cairnId: string, data: Buffer | string, filename = 'notes.txt') {
  return request(t.app)
    .post(`/api/cairns/${cairnId}/sources`)
    .set('Cookie', cookie)
    .set('Origin', APP_ORIGIN)
    .attach('file', Buffer.from(data), filename);
}

describe('GET /api/cairns/:id', () => {
  it("returns the caller's cairn and 404s for others, unknown and malformed ids", async () => {
    const { cookie, cairnId } = await signedInWithCairn();
    const other = await t.signIn((await t.createUser()).id);

    const res = await request(t.app)
      .get(`/api/cairns/${cairnId}`)
      .set('Cookie', cookie)
      .expect(200);
    expect(res.body.cairn).toMatchObject({ id: cairnId, name: 'Docs' });
    await request(t.app).get(`/api/cairns/${cairnId}`).set('Cookie', other).expect(404);
    await request(t.app).get(`/api/cairns/${randomUUID()}`).set('Cookie', cookie).expect(404);
    await request(t.app).get('/api/cairns/not-a-uuid').set('Cookie', cookie).expect(404);
  });
});

describe('POST /api/cairns/:id/sources', () => {
  it('stores the file, records a pending source and queues it for the uploader', async () => {
    const { user, cookie, cairnId } = await signedInWithCairn();
    const res = await upload(cookie, cairnId, '# Trail notes\n\nשלום', 'trail.md').expect(202);

    const source = res.body.source;
    expect(source).toMatchObject({
      cairnId,
      kind: 'markdown',
      mime: 'text/markdown',
      filename: 'trail.md',
      size: Buffer.byteLength('# Trail notes\n\nשלום'),
      status: 'pending',
      error: null,
    });
    const [row] = await t.admin.select().from(sources);
    expect(t.storage.objects.get(row!.storageKey)).toMatchObject({ contentType: 'text/markdown' });
    expect(Buffer.from(t.storage.objects.get(row!.storageKey)!.body).toString()).toBe(
      '# Trail notes\n\nשלום',
    );

    const job = await t.ingest.queue.getJob(source.id);
    expect(job?.data).toEqual({ sourceId: source.id, userId: user.id });
  });

  it('keeps non-ASCII file names intact', async () => {
    const { cookie, cairnId } = await signedInWithCairn();
    const res = await upload(cookie, cairnId, 'hello', 'דוח שנתי.txt').expect(202);
    expect(res.body.source.filename).toBe('דוח שנתי.txt');
  });

  it('detects PDFs from their bytes', async () => {
    const { cookie, cairnId } = await signedInWithCairn();
    const res = await upload(cookie, cairnId, '%PDF-1.7\n...', 'scan.bin').expect(202);
    expect(res.body.source).toMatchObject({ kind: 'pdf', mime: 'application/pdf' });
  });

  it('rejects unsupported, empty and oversized files without storing anything', async () => {
    const { cookie, cairnId } = await signedInWithCairn();

    const binary = await upload(
      cookie,
      cairnId,
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0]),
      'x.txt',
    ).expect(415);
    expect(binary.body.error).toMatch(/text, Markdown, PDF, CSV, JSON and image/);
    await upload(cookie, cairnId, '', 'empty.txt').expect(400);
    const big = await upload(cookie, cairnId, 'x'.repeat(1_000_001)).expect(413);
    expect(big.body.error).toMatch(/limited to 1 MB/);

    expect(await t.admin.select().from(sources)).toEqual([]);
    expect(t.storage.objects.size).toBe(0);
  });

  it('rejects requests without a file or with two', async () => {
    const { cookie, cairnId } = await signedInWithCairn();
    const url = `/api/cairns/${cairnId}/sources`;

    await request(t.app)
      .post(url)
      .set('Cookie', cookie)
      .set('Origin', APP_ORIGIN)
      .send({})
      .expect(400);
    await request(t.app)
      .post(url)
      .set('Cookie', cookie)
      .set('Origin', APP_ORIGIN)
      .attach('other', Buffer.from('x'), 'a.txt')
      .expect(400);
    await request(t.app)
      .post(url)
      .set('Cookie', cookie)
      .set('Origin', APP_ORIGIN)
      .attach('file', Buffer.from('a'), 'a.txt')
      .attach('file', Buffer.from('b'), 'b.txt')
      .expect(400);
  });

  it("404s for someone else's cairn and needs the app origin", async () => {
    const { cairnId } = await signedInWithCairn();
    const other = await t.signIn((await t.createUser()).id);

    await upload(other, cairnId, 'hi').expect(404);
    await request(t.app)
      .post(`/api/cairns/${cairnId}/sources`)
      .set('Cookie', other)
      .attach('file', Buffer.from('hi'), 'a.txt')
      .expect(403);
    expect(t.storage.objects.size).toBe(0);
  });

  it('removes the source row if storing the file fails', async () => {
    const { cookie, cairnId } = await signedInWithCairn();
    vi.spyOn(t.storage, 'put').mockRejectedValueOnce(new Error('s3 down'));
    vi.spyOn(console, 'error').mockImplementation(() => {});

    await upload(cookie, cairnId, 'hello').expect(500);
    expect(await t.admin.select().from(sources)).toEqual([]);
    vi.restoreAllMocks();
  });
});

describe('GET /api/cairns/:id/sources', () => {
  it("lists the cairn's sources newest first, only for its owner", async () => {
    const { cookie, cairnId } = await signedInWithCairn();
    await upload(cookie, cairnId, 'one', 'one.txt').expect(202);
    await upload(cookie, cairnId, 'two', 'two.txt').expect(202);
    const other = await t.signIn((await t.createUser()).id);

    const res = await request(t.app)
      .get(`/api/cairns/${cairnId}/sources`)
      .set('Cookie', cookie)
      .expect(200);
    expect(res.body.sources.map((s: { filename: string }) => s.filename)).toEqual([
      'two.txt',
      'one.txt',
    ]);
    await request(t.app).get(`/api/cairns/${cairnId}/sources`).set('Cookie', other).expect(404);
  });
});

describe('DELETE /api/cairns/:id/sources/:sourceId', () => {
  it('deletes the row, the stored file and the queued job', async () => {
    const { cookie, cairnId } = await signedInWithCairn();
    const { body } = await upload(cookie, cairnId, 'hello').expect(202);
    const url = `/api/cairns/${cairnId}/sources/${body.source.id}`;

    await request(t.app).delete(url).set('Cookie', cookie).set('Origin', APP_ORIGIN).expect(204);
    expect(await t.admin.select().from(sources)).toEqual([]);
    expect(t.storage.objects.size).toBe(0);
    expect(await t.ingest.queue.getJob(body.source.id)).toBeUndefined();
    await request(t.app).delete(url).set('Cookie', cookie).set('Origin', APP_ORIGIN).expect(404);
  });

  it("404s for another user's source or a source of a different cairn", async () => {
    const alice = await signedInWithCairn();
    const { body } = await upload(alice.cookie, alice.cairnId, 'hello').expect(202);
    const bob = await signedInWithCairn();

    await request(t.app)
      .delete(`/api/cairns/${alice.cairnId}/sources/${body.source.id}`)
      .set('Cookie', bob.cookie)
      .set('Origin', APP_ORIGIN)
      .expect(404);
    // Alice's own source, addressed under a cairn it doesn't belong to.
    const aliceSecond = await request(t.app)
      .post('/api/cairns')
      .set('Cookie', alice.cookie)
      .set('Origin', APP_ORIGIN)
      .send({ name: 'Other' });
    await request(t.app)
      .delete(`/api/cairns/${aliceSecond.body.cairn.id}/sources/${body.source.id}`)
      .set('Cookie', alice.cookie)
      .set('Origin', APP_ORIGIN)
      .expect(404);
    expect(await t.admin.select().from(sources)).toHaveLength(1);
  });
});

describe('GET /api/cairns/:id/sources/:sourceId/file', () => {
  const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);

  it('serves an image source inertly to cited callers', async () => {
    const { cookie, cairnId } = await signedInWithCairn();
    const { body } = await upload(cookie, cairnId, PNG, 'trail sign.png').expect(202);

    const res = await request(t.app)
      .get(`/api/cairns/${cairnId}/sources/${body.source.id}/file`)
      .set('Cookie', cookie)
      .buffer(true)
      .parse((r, done) => {
        const chunks: Buffer[] = [];
        r.on('data', (c: Buffer) => chunks.push(c));
        r.on('end', () => done(null, Buffer.concat(chunks)));
      })
      .expect(200);
    expect(res.body).toEqual(PNG);
    expect(res.headers).toMatchObject({
      'content-type': 'image/png',
      'x-content-type-options': 'nosniff',
      'content-security-policy': "default-src 'none'; sandbox",
      'content-disposition': "inline; filename*=UTF-8''trail%20sign.png",
    });
  });

  it('404s for non-image sources and other cairns; 403 for sealed callers', async () => {
    const { cookie, cairnId } = await signedInWithCairn();
    const text = (await upload(cookie, cairnId, 'hello').expect(202)).body.source.id as string;
    const image = (await upload(cookie, cairnId, PNG, 'a.png').expect(202)).body.source
      .id as string;
    await request(t.app)
      .get(`/api/cairns/${cairnId}/sources/${text}/file`)
      .set('Cookie', cookie)
      .expect(404);

    const other = await signedInWithCairn();
    await request(t.app)
      .get(`/api/cairns/${other.cairnId}/sources/${image}/file`)
      .set('Cookie', other.cookie)
      .expect(404);

    await request(t.app)
      .post(`/api/cairns/${cairnId}/shares`)
      .set('Cookie', cookie)
      .set('Origin', APP_ORIGIN)
      .send({ kind: 'email', email: other.user.email, role: 'viewer', visibility: 'sealed' })
      .expect(201);
    await request(t.app)
      .get(`/api/cairns/${cairnId}/sources/${image}/file`)
      .set('Cookie', other.cookie)
      .expect(403);
  });
});

function addUrl(cookie: string, cairnId: string, url: string) {
  return request(t.app)
    .post(`/api/cairns/${cairnId}/sources`)
    .set('Cookie', cookie)
    .set('Origin', APP_ORIGIN)
    .send({ url });
}

async function shareWith(owner: string, cairnId: string, email: string, role: string) {
  await request(t.app)
    .post(`/api/cairns/${cairnId}/shares`)
    .set('Cookie', owner)
    .set('Origin', APP_ORIGIN)
    .send({ kind: 'email', email, role, visibility: 'cited' })
    .expect(201);
}

describe('POST /api/cairns/:id/sources with a URL', () => {
  it('records a pending web source without a fragment and queues it; nothing is stored yet', async () => {
    const { user, cookie, cairnId } = await signedInWithCairn();
    const res = await addUrl(cookie, cairnId, ' HTTPS://Example.com:443/trails?id=7#map ').expect(
      202,
    );
    expect(res.body.source).toMatchObject({
      cairnId,
      kind: 'web',
      url: 'https://example.com/trails?id=7',
      filename: 'https://example.com/trails?id=7',
      status: 'pending',
    });
    expect(t.storage.objects.size).toBe(0);
    const job = await t.ingest.queue.getJob(res.body.source.id);
    expect(job?.data).toEqual({ sourceId: res.body.source.id, userId: user.id });
  });

  it('409s for a page already in the cairn, with the existing source', async () => {
    const { cookie, cairnId } = await signedInWithCairn();
    const first = await addUrl(cookie, cairnId, 'https://example.com/a').expect(202);
    const again = await addUrl(cookie, cairnId, 'https://example.com/a#part-2').expect(409);
    expect(again.body.error).toMatch(/already in the cairn/);
    expect(again.body.source.id).toBe(first.body.source.id);
    // Another cairn may have the same page.
    const other = await signedInWithCairn();
    await addUrl(other.cookie, other.cairnId, 'https://example.com/a').expect(202);
  });

  it('rejects bad and internal URLs without recording anything', async () => {
    const { cookie, cairnId } = await signedInWithCairn();
    for (const [url, message] of [
      ['not a url', /not a valid URL/],
      ['file:///etc/passwd', /only http and https/],
      ['http://127.0.0.1/admin', /private or internal/],
      ['http://169.254.169.254/latest/meta-data/', /private or internal/],
      ['http://example.com:6379/', /standard web ports/],
    ] as const) {
      const res = await addUrl(cookie, cairnId, url).expect(400);
      expect(res.body.error, url).toMatch(message);
    }
    await addUrl(cookie, cairnId, '').expect(400);
    expect(await t.admin.select().from(sources)).toHaveLength(0);
  });

  it('lets editors add pages, not viewers', async () => {
    const { cookie, cairnId } = await signedInWithCairn();
    const editor = await signedInWithCairn();
    const viewer = await signedInWithCairn();
    await shareWith(cookie, cairnId, editor.user.email, 'editor');
    await shareWith(cookie, cairnId, viewer.user.email, 'viewer');
    await addUrl(editor.cookie, cairnId, 'https://example.com/e').expect(202);
    await addUrl(viewer.cookie, cairnId, 'https://example.com/v').expect(403);
  });
});

describe('POST /api/cairns/:id/sources/:sourceId/refresh', () => {
  const refresh = (cookie: string, cairnId: string, sourceId: string) =>
    request(t.app)
      .post(`/api/cairns/${cairnId}/sources/${sourceId}/refresh`)
      .set('Cookie', cookie)
      .set('Origin', APP_ORIGIN);

  it('sets a ready or failed page back to pending and queues it again', async () => {
    const { user, cookie, cairnId } = await signedInWithCairn();
    const { body } = await addUrl(cookie, cairnId, 'https://example.com/a').expect(202);
    const id = body.source.id as string;

    // Still pending: the first fetch hasn't happened.
    await refresh(cookie, cairnId, id).expect(409);

    // The worker finished; its job stays in the queue under the source's id.
    const job = await t.ingest.queue.getJob(id);
    await job!.remove();
    await t.ingest.queue.add('ingest', { sourceId: id, userId: user.id }, { jobId: id });
    await t.admin.update(sources).set({ status: 'failed', error: 'the site answered 503' });

    const res = await refresh(cookie, cairnId, id).expect(202);
    expect(res.body.source).toMatchObject({ id, status: 'pending', error: null });
    expect((await t.ingest.queue.getJob(id))?.data).toEqual({ sourceId: id, userId: user.id });
  });

  it('refuses uploads, viewers, and other cairns', async () => {
    const { cookie, cairnId } = await signedInWithCairn();
    const file = (await upload(cookie, cairnId, 'hello').expect(202)).body.source.id as string;
    await t.admin.update(sources).set({ status: 'ready' });
    await refresh(cookie, cairnId, file).expect(400);

    const page = (await addUrl(cookie, cairnId, 'https://example.com/a').expect(202)).body.source
      .id as string;
    await t.admin.update(sources).set({ status: 'ready' });
    const viewer = await signedInWithCairn();
    await shareWith(cookie, cairnId, viewer.user.email, 'viewer');
    await refresh(viewer.cookie, cairnId, page).expect(403);
    await refresh(viewer.cookie, viewer.cairnId, page).expect(404);
  });
});
