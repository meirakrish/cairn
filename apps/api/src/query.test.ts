import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { AnswerEvent } from '@cairn/shared';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
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
afterEach(() => vi.restoreAllMocks());
afterAll(async () => {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  await t.close();
});

async function signedInWithChunks(texts: string[]) {
  const user = await t.createUser();
  const cookie = await t.signIn(user.id);
  const cairnId = (
    await request(t.app)
      .post('/api/cairns')
      .set('Cookie', cookie)
      .set('Origin', APP_ORIGIN)
      .send({ name: 'Docs' })
      .expect(201)
  ).body.cairn.id as string;
  const source = await t.sources.create(user.id, cairnId, {
    kind: 'text',
    filename: 'notes.txt',
    mime: 'text/plain',
    size: 1,
  });
  const vectors = await t.embedder.embed(texts);
  await t.sources.complete(
    user.id,
    source.id,
    texts.map((content, i) => ({ content, location: { offset: i }, embedding: vectors[i]! })),
  );
  return { user, cookie, cairnId };
}

/** POSTs a question and returns the parsed SSE events once the stream ends. */
async function ask(cairnId: string, cookie: string, question: string) {
  const res = await fetch(`${base}/api/cairns/${cairnId}/query`, {
    method: 'POST',
    headers: { cookie, origin: APP_ORIGIN, 'content-type': 'application/json' },
    body: JSON.stringify({ question }),
  });
  const body = await res.text();
  const events = body
    .split('\n\n')
    .filter((block) => block.startsWith('data: '))
    .map((block) => AnswerEvent.parse(JSON.parse(block.slice(6))));
  return { res, events };
}

describe('POST /api/cairns/:id/query', () => {
  it('streams passages, the answer and citations as SSE', async () => {
    const { cookie, cairnId } = await signedInWithChunks(['The deadline is the 15th.']);
    t.script({ stream: [['The deadline is ', 'the 15th [1].']] });

    const { res, events } = await ask(cairnId, cookie, '  When is the deadline?  ');
    expect(res.headers.get('content-type')).toMatch(/^text\/event-stream/);
    expect(events.map((e) => e.type)).toEqual(['passages', 'delta', 'delta', 'done']);
    expect(events[0]).toMatchObject({
      passages: [{ n: 1, filename: 'notes.txt', text: 'The deadline is the 15th.' }],
    });
    expect(events.at(-1)).toMatchObject({ type: 'done', cited: [1] });
  });

  it('checks the session, origin, input and cairn before streaming, with JSON errors', async () => {
    const { cookie, cairnId } = await signedInWithChunks(['x']);
    const other = await t.signIn((await t.createUser()).id);
    const url = `/api/cairns/${cairnId}/query`;
    const post = (c?: string) => {
      const r = request(t.app).post(url).set('Origin', APP_ORIGIN);
      return c ? r.set('Cookie', c) : r;
    };

    await post().send({ question: 'q' }).expect(401);
    await request(t.app).post(url).set('Cookie', cookie).send({ question: 'q' }).expect(403);
    await post(cookie).send({ question: '   ' }).expect(400);
    await post(cookie)
      .send({ question: 'x'.repeat(1001) })
      .expect(400);
    await post(other).send({ question: 'q' }).expect(404);
  });

  it('rate-limits questions per user', async () => {
    const { cookie, cairnId } = await signedInWithChunks(['x']);
    t.script({ stream: Array.from({ length: 5 }, () => ['ok']) });
    // Rate limits use fixed one-minute windows; don't let the test straddle two.
    vi.spyOn(Date, 'now').mockReturnValue(Date.now());

    for (let i = 0; i < t.config.queryRateLimit; i++) {
      expect((await ask(cairnId, cookie, `q${i}`)).res.status).toBe(200);
    }
    const limited = await ask(cairnId, cookie, 'one more');
    expect(limited.res.status).toBe(429);
    expect(Number(limited.res.headers.get('retry-after'))).toBeGreaterThan(0);
  });

  it('ends the stream with an error event when the model fails', async () => {
    const { cookie, cairnId } = await signedInWithChunks(['x']);
    t.script({ stream: [Object.assign(new Error('timed out'), { name: 'TimeoutError' })] });
    const quiet = console.error;
    console.error = () => {};
    try {
      const { events } = await ask(cairnId, cookie, 'q');
      expect(events.map((e) => e.type)).toEqual(['passages', 'error']);
      expect(events[1]).toEqual({ type: 'error', message: 'Could not answer: request timed out' });
    } finally {
      console.error = quiet;
    }
  });
});
