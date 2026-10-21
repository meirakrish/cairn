import { QuizQuestionResponse, QuizResultResponse } from '@cairn/shared';
import request from 'supertest';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { APP_ORIGIN, createTestApp } from './testing';

// Different questions need different words: similarQuestion() treats rewordings as copies.
const TOPICS = [
  'alpha',
  'bravo',
  'charlie',
  'delta',
  'echo',
  'foxtrot',
  'golf',
  'hotel',
  'india',
  'juliett',
];
const t = createTestApp();

beforeEach(() => t.reset());
afterEach(() => vi.restoreAllMocks());
afterAll(() => t.close());

const passage =
  'Cairns are piles of stones that mark hiking trails above the tree line, where paths are hard to see.';
const choiceDraft = {
  question: 'What do cairns mark?',
  options: ['Trails', 'Rivers', 'Graves', 'Borders'],
  correctOption: 0,
  explanation: 'Cairns mark trails.',
};
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
  return { user, cookie, cairnId, sourceId: source.id };
}

const post = (path: string, cookie: string) =>
  request(t.app).post(path).set('Cookie', cookie).set('Origin', APP_ORIGIN);

describe('POST /api/cairns/:id/quiz', () => {
  it('returns a multiple-choice question without its answer, then checks the pick', async () => {
    const { cookie, cairnId, sourceId } = await signedInWithChunks([passage]);
    const llm = t.script({ structured: [choiceDraft] });

    const created = await post(`/api/cairns/${cairnId}/quiz`, cookie).send({}).expect(201);
    const { question } = QuizQuestionResponse.parse(created.body);
    expect(JSON.stringify(created.body)).not.toContain('explanation');
    expect(JSON.stringify(created.body)).not.toContain('correct');
    expect(JSON.stringify(created.body)).not.toContain('Cairns mark trails.');

    const right = question.choices!.indexOf('Trails');
    const answered = await post(`/api/cairns/${cairnId}/quiz/${question.id}/answer`, cookie)
      .send({ choice: right })
      .expect(200);
    expect(QuizResultResponse.parse(answered.body).result).toEqual({
      verdict: 'correct',
      correctChoice: right,
      answer: 'Trails',
      explanation: 'Cairns mark trails.',
      passage: {
        sourceId,
        filename: 'notes.txt',
        kind: 'text',
        url: null,
        location: { offset: 0 },
        text: passage,
      },
    });
    expect(llm.calls).toHaveLength(1);

    await post(`/api/cairns/${cairnId}/quiz/${question.id}/answer`, cookie)
      .send({ choice: right })
      .expect(409);
  });

  it('writes the next question in the background, so it comes from the bank', async () => {
    const { cookie, cairnId } = await signedInWithChunks([passage, `${passage} Again.`]);
    let n = 0;
    const llm = t.script({
      structured: () => ({ ...choiceDraft, question: `What about ${TOPICS[n++]}?` }),
    });
    const prefetch = t.config.quizPrefetch;
    t.config.quizPrefetch = 1;
    try {
      await post(`/api/cairns/${cairnId}/quiz`, cookie).send({}).expect(201);
      await vi.waitFor(() => expect(llm.calls).toHaveLength(2));
      const next = await post(`/api/cairns/${cairnId}/quiz`, cookie).send({}).expect(201);
      expect(next.body.question).toMatchObject({
        question: 'What about bravo?',
        seenBefore: false,
      });
      // And the one after; let it finish before the database is reset.
      await vi.waitFor(() => expect(llm.calls).toHaveLength(3));
    } finally {
      t.config.quizPrefetch = prefetch;
    }
  });

  it('validates the request', async () => {
    const { cookie, cairnId } = await signedInWithChunks([passage]);
    await post(`/api/cairns/${cairnId}/quiz/not-a-uuid/answer`, cookie)
      .send({ choice: 0 })
      .expect(404);
    await post(`/api/cairns/${cairnId}/quiz/${crypto.randomUUID()}/answer`, cookie)
      .send({ choice: 'A' })
      .expect(400);
  });

  it('says so when there is nothing to quiz on', async () => {
    const { cookie } = await signedInWithChunks([]);
    const empty = (await post('/api/cairns', cookie).send({ name: 'Empty' }).expect(201)).body.cairn
      .id as string;
    const res = await post(`/api/cairns/${empty}/quiz`, cookie).send({}).expect(400);
    expect(res.body.error).toMatch(/no ready files/);
  });

  it('refuses sealed callers and strangers', async () => {
    const { cookie, cairnId } = await signedInWithChunks([passage]);
    const guest = await t.createUser();
    await post(`/api/cairns/${cairnId}/shares`, cookie)
      .send({ kind: 'email', email: guest.email, role: 'viewer', visibility: 'sealed' })
      .expect(201);
    const llm = t.script({ structured: [choiceDraft] });

    await post(`/api/cairns/${cairnId}/quiz`, await t.signIn(guest.id))
      .send({})
      .expect(403);
    const stranger = await t.createUser();
    await post(`/api/cairns/${cairnId}/quiz`, await t.signIn(stranger.id))
      .send({})
      .expect(404);
    expect(llm.calls).toEqual([]);
  });

  it('counts new questions against the question rate limit', async () => {
    const { cookie, cairnId } = await signedInWithChunks([passage]);
    t.script({ structured: () => choiceDraft });
    // Rate limits use fixed one-minute windows; don't let the test straddle two.
    vi.spyOn(Date, 'now').mockReturnValue(Date.now());

    for (let i = 0; i < t.config.queryRateLimit; i++) {
      await post(`/api/cairns/${cairnId}/quiz`, cookie).send({}).expect(201);
    }
    const limited = await post(`/api/cairns/${cairnId}/quiz`, cookie).send({}).expect(429);
    expect(Number(limited.headers['retry-after'])).toBeGreaterThan(0);
  });

  it('names a model failure', async () => {
    const { cookie, cairnId } = await signedInWithChunks([passage]);
    t.script({ structured: [Object.assign(new Error('timed out'), { name: 'TimeoutError' })] });
    vi.spyOn(console, 'error').mockImplementation(() => {});

    const res = await post(`/api/cairns/${cairnId}/quiz`, cookie).send({}).expect(502);
    expect(res.body.error).toBe('Could not write a question: request timed out');
  });
});
