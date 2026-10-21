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
    expect(binary.body.error).toMatch(/text, Markdown, PDF and CSV/);
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
