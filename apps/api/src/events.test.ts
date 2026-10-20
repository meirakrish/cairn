import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { SourceEvent } from '@cairn/shared';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { APP_ORIGIN, createTestApp } from './testing';

const t = createTestApp();
let server: Server;
let base: string;

beforeAll(async () => {
  server = t.app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  base = `http://localhost:${(server.address() as AddressInfo).port}`;
});
beforeEach(() => t.reset());
afterAll(async () => {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  await t.close();
});

/** Opens the event stream and yields parsed messages; `close()` disconnects. */
async function openStream(cairnId: string, cookie: string) {
  const controller = new AbortController();
  const res = await fetch(`${base}/api/cairns/${cairnId}/events`, {
    headers: { cookie },
    signal: controller.signal,
  });
  const reader = res.body!.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = '';
  let ended = false;

  async function next(timeoutMs = 2000): Promise<SourceEvent | 'end'> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const at = buffer.indexOf('\n\n');
      if (at !== -1) {
        const block = buffer.slice(0, at);
        buffer = buffer.slice(at + 2);
        const data = block.split('\n').find((l) => l.startsWith('data: '));
        if (data) return SourceEvent.parse(JSON.parse(data.slice(6)));
        continue; // a ": ping" comment
      }
      if (ended) return 'end';
      const left = deadline - Date.now();
      if (left <= 0) throw new Error('no event within timeout');
      const chunk = await Promise.race([
        reader.read(),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('no event within timeout')), left),
        ),
      ]);
      if (chunk.done) ended = true;
      else buffer += chunk.value;
    }
  }

  return { res, next, close: () => controller.abort() };
}

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

const upload = (cookie: string, cairnId: string, name = 'a.txt') =>
  request(t.app)
    .post(`/api/cairns/${cairnId}/sources`)
    .set('Cookie', cookie)
    .set('Origin', APP_ORIGIN)
    .attach('file', Buffer.from('hello'), name)
    .expect(202);

async function eventually(check: () => boolean, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error('condition not met in time');
    await new Promise((r) => setTimeout(r, 10));
  }
}

describe('GET /api/cairns/:id/events', () => {
  it('needs a session and access to the cairn', async () => {
    const { cairnId } = await signedInWithCairn();
    const other = await t.signIn((await t.createUser()).id);

    await request(t.app).get(`/api/cairns/${cairnId}/events`).expect(401);
    await request(t.app).get(`/api/cairns/${cairnId}/events`).set('Cookie', other).expect(404);
  });

  it('sends a snapshot, then every change to the cairn’s sources', async () => {
    const { user, cookie, cairnId } = await signedInWithCairn();
    const existing = (await upload(cookie, cairnId, 'old.txt')).body.source;
    const stream = await openStream(cairnId, cookie);
    expect(stream.res.headers.get('content-type')).toMatch(/^text\/event-stream/);

    expect(await stream.next()).toEqual({ type: 'snapshot', sources: [existing] });

    const uploaded = (await upload(cookie, cairnId, 'new.txt')).body.source;
    expect(await stream.next()).toMatchObject({
      type: 'source',
      source: { id: uploaded.id, status: 'pending' },
    });

    // The worker's changes arrive the same way.
    await t.sources.markProcessing(user.id, uploaded.id);
    expect(await stream.next()).toMatchObject({
      source: { id: uploaded.id, status: 'processing' },
    });
    await t.sources.fail(user.id, uploaded.id, 'no text found in the file');
    expect(await stream.next()).toMatchObject({
      source: { id: uploaded.id, status: 'failed', error: 'no text found in the file' },
    });

    await request(t.app)
      .delete(`/api/cairns/${cairnId}/sources/${existing.id}`)
      .set('Cookie', cookie)
      .set('Origin', APP_ORIGIN)
      .expect(204);
    expect(await stream.next()).toEqual({ type: 'source_deleted', sourceId: existing.id });
    stream.close();
  });

  it("does not send other cairns' changes", async () => {
    const alice = await signedInWithCairn();
    const bob = await signedInWithCairn();
    const stream = await openStream(alice.cairnId, alice.cookie);
    await stream.next(); // snapshot

    await upload(bob.cookie, bob.cairnId);
    const own = (await upload(alice.cookie, alice.cairnId)).body.source;
    // The next event is Alice's own upload, not Bob's.
    expect(await stream.next()).toMatchObject({ source: { id: own.id, cairnId: alice.cairnId } });
    stream.close();
  });

  it('unsubscribes when the client disconnects', async () => {
    const { cookie, cairnId } = await signedInWithCairn();
    const a = await openStream(cairnId, cookie);
    const b = await openStream(cairnId, cookie);
    await a.next();
    await b.next();
    expect(t.hub.channels).toEqual([`cairn:${cairnId}:events`]);

    a.close();
    await new Promise((r) => setTimeout(r, 100));
    expect(t.hub.channels).toHaveLength(1); // b still listens
    b.close();
    await eventually(() => t.hub.channels.length === 0);
  });

  it('ends the stream after logout', async () => {
    const { cookie, cairnId } = await signedInWithCairn();
    const stream = await openStream(cairnId, cookie);
    await stream.next();

    await request(t.app)
      .post('/api/auth/logout')
      .set('Cookie', cookie)
      .set('Origin', APP_ORIGIN)
      .expect(204);
    expect(await stream.next()).toBe('end');
    await eventually(() => t.hub.channels.length === 0);
  });
});
