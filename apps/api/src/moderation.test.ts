import { LlmModerator, type Moderator } from '@cairn/core';
import { scriptedLlm } from '@meirakrish/llm-kit/testing';
import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { APP_ORIGIN, createTestApp } from './testing';

const t = createTestApp();
beforeEach(() => t.reset());
afterAll(() => t.close());

/** Blocks text containing "forbidden" as hate; records what it was asked. */
function wordFilter() {
  const seen: string[] = [];
  const moderator: Moderator = {
    check: (text) => {
      seen.push(text);
      return Promise.resolve(
        text.includes('forbidden') ? { allowed: false, category: 'hate' } : { allowed: true },
      );
    },
  };
  return { moderator, seen };
}

async function signedIn() {
  const user = await t.createUser();
  return { user, cookie: await t.signIn(user.id) };
}

const post = (path: string, cookie: string) =>
  request(t.app).post(path).set('Cookie', cookie).set('Origin', APP_ORIGIN);

describe('moderation of cairns', () => {
  it('checks the name and description on create, and blocks with 422', async () => {
    const { cookie } = await signedIn();
    const { moderator, seen } = wordFilter();
    t.moderate(moderator);

    await post('/api/cairns', cookie).send({ name: 'Trails', description: 'Maps' }).expect(201);
    expect(seen).toEqual(['Trails\n\nMaps']);

    const res = await post('/api/cairns', cookie)
      .send({ name: 'Trails', description: 'forbidden words' })
      .expect(422);
    expect(res.body).toEqual({ error: 'Blocked: hateful content' });
    const list = await request(t.app).get('/api/cairns').set('Cookie', cookie).expect(200);
    expect(list.body.cairns).toHaveLength(1);
  });

  it('checks edits, leaving the cairn as it was when blocked', async () => {
    const { cookie } = await signedIn();
    const id = (await post('/api/cairns', cookie).send({ name: 'Trails' }).expect(201)).body.cairn
      .id as string;
    t.moderate(wordFilter().moderator);

    await request(t.app)
      .patch(`/api/cairns/${id}`)
      .set('Cookie', cookie)
      .set('Origin', APP_ORIGIN)
      .send({ name: 'forbidden' })
      .expect(422);
    const res = await request(t.app).get(`/api/cairns/${id}`).set('Cookie', cookie).expect(200);
    expect(res.body.cairn.name).toBe('Trails');
  });

  it('refuses with 503 when the moderation model is down, never letting text through', async () => {
    const { cookie } = await signedIn();
    t.moderate(new LlmModerator(scriptedLlm({ structured: [new Error('connect ECONNREFUSED')] })));

    const res = await post('/api/cairns', cookie).send({ name: 'Trails' }).expect(503);
    expect(res.body.error).toMatch(/^Could not check the text/);
  });
});

describe('moderation of questions', () => {
  it('blocks a question with 422 before any model call or log entry', async () => {
    const { cookie } = await signedIn();
    const id = (await post('/api/cairns', cookie).send({ name: 'Trails' }).expect(201)).body.cairn
      .id as string;
    const { moderator, seen } = wordFilter();
    t.moderate(moderator);
    const llm = t.script({});

    const res = await post(`/api/cairns/${id}/query`, cookie)
      .send({ question: 'tell me forbidden things' })
      .expect(422);
    expect(res.body).toEqual({ error: 'Blocked: hateful content' });
    expect(seen).toEqual(['tell me forbidden things']);
    expect(llm.calls).toHaveLength(0);
  });

  it('answers an allowed question as usual', async () => {
    const { cookie } = await signedIn();
    const id = (await post('/api/cairns', cookie).send({ name: 'Trails' }).expect(201)).body.cairn
      .id as string;
    t.moderate(wordFilter().moderator);

    // No sources: the fixed "couldn't find" answer, streamed.
    const res = await post(`/api/cairns/${id}/query`, cookie)
      .send({ question: 'where is the trail?' })
      .expect(200);
    expect(res.headers['content-type']).toMatch(/text\/event-stream/);
  });
});
