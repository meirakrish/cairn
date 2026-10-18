import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { APP_ORIGIN, createTestApp } from './testing';

const t = createTestApp();

beforeEach(() => t.reset());
afterAll(() => t.close());

function create(cookie: string, body: unknown) {
  return request(t.app)
    .post('/api/cairns')
    .set('Cookie', cookie)
    .set('Origin', APP_ORIGIN)
    .send(body as object);
}

describe('/api/cairns', () => {
  it('requires a session', async () => {
    await request(t.app).get('/api/cairns').expect(401);
    await request(t.app)
      .post('/api/cairns')
      .set('Origin', APP_ORIGIN)
      .send({ name: 'x' })
      .expect(401);
  });

  it('creates a cairn, trimming input and storing the configured embed model', async () => {
    const cookie = await t.signIn((await t.createUser()).id);
    const res = await create(cookie, { name: '  Taxes  ', description: '  ' }).expect(201);

    expect(res.body.cairn).toMatchObject({
      name: 'Taxes',
      description: null,
      embedModel: t.config.embedModel,
    });
    expect(new Date(res.body.cairn.createdAt).toISOString()).toBe(res.body.cairn.createdAt);
  });

  it('rejects invalid input with field issues', async () => {
    const cookie = await t.signIn((await t.createUser()).id);
    const res = await create(cookie, { name: '   ' }).expect(400);

    expect(res.body.issues.name).toBeDefined();
    await create(cookie, { name: 'x'.repeat(101) }).expect(400);
  });

  it('rejects malformed JSON with 400', async () => {
    const cookie = await t.signIn((await t.createUser()).id);
    await request(t.app)
      .post('/api/cairns')
      .set('Cookie', cookie)
      .set('Origin', APP_ORIGIN)
      .set('Content-Type', 'application/json')
      .send('{nope')
      .expect(400);
  });

  it('rejects creates from another origin', async () => {
    const cookie = await t.signIn((await t.createUser()).id);
    await request(t.app).post('/api/cairns').set('Cookie', cookie).send({ name: 'x' }).expect(403);
    await request(t.app)
      .post('/api/cairns')
      .set('Cookie', cookie)
      .set('Origin', 'https://evil.example')
      .send({ name: 'x' })
      .expect(403);
  });

  it("lists only the caller's cairns, newest first", async () => {
    const a = await t.signIn((await t.createUser()).id);
    const b = await t.signIn((await t.createUser()).id);
    await create(a, { name: 'A1' }).expect(201);
    await create(a, { name: 'A2' }).expect(201);
    await create(b, { name: 'B1' }).expect(201);

    const listA = await request(t.app).get('/api/cairns').set('Cookie', a).expect(200);
    const listB = await request(t.app).get('/api/cairns').set('Cookie', b).expect(200);

    expect(listA.body.cairns.map((c: { name: string }) => c.name)).toEqual(['A2', 'A1']);
    expect(listB.body.cairns.map((c: { name: string }) => c.name)).toEqual(['B1']);
  });
});

describe('/api fallbacks', () => {
  it('returns JSON 404 for unknown routes', async () => {
    const res = await request(t.app).get('/api/nope').expect(404);
    expect(res.body).toEqual({ error: 'not found' });
  });
});
