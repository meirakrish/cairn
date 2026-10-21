import type { User } from '@cairn/core';
import { CreateShareResponse, ListCairnsResponse, ListSharesResponse } from '@cairn/shared';
import request from 'supertest';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { APP_ORIGIN, createTestApp } from './testing';

const t = createTestApp();

beforeEach(() => t.reset());
afterEach(() => vi.restoreAllMocks());
afterAll(() => t.close());

interface Person {
  user: User;
  cookie: string;
}

async function person(email?: string): Promise<Person> {
  const user = await t.createUser(email ? { email } : {});
  return { user, cookie: await t.signIn(user.id) };
}

const post = (who: Person, path: string, body?: object) =>
  request(t.app).post(path).set('Cookie', who.cookie).set('Origin', APP_ORIGIN).send(body);
const get = (who: Person, path: string) => request(t.app).get(path).set('Cookie', who.cookie);
const del = (who: Person, path: string) =>
  request(t.app).delete(path).set('Cookie', who.cookie).set('Origin', APP_ORIGIN);

/** An owner, their cairn with one ready source, and a guest. */
async function setup() {
  const owner = await person('owner@example.test');
  const guest = await person('guest@example.test');
  const cairnId = (await post(owner, '/api/cairns', { name: 'Docs' }).expect(201)).body.cairn
    .id as string;
  const source = await t.sources.create(owner.user.id, cairnId, {
    kind: 'text',
    filename: 'notes.txt',
    mime: 'text/plain',
    size: 1,
  });
  return { owner, guest, cairnId, sourceId: source.id };
}

const shareWith = (
  owner: Person,
  cairnId: string,
  email: string,
  role: string,
  visibility: string,
) => post(owner, `/api/cairns/${cairnId}/shares`, { kind: 'email', email, role, visibility });

describe('shares api', () => {
  it('lets the owner share by email and by link, list and revoke', async () => {
    const { owner, cairnId } = await setup();

    const email = CreateShareResponse.parse(
      (await shareWith(owner, cairnId, ' Friend@Example.test ', 'viewer', 'sealed').expect(201))
        .body,
    );
    expect(email).toEqual({
      share: expect.objectContaining({
        kind: 'email',
        email: 'friend@example.test',
        redeemedBy: [],
      }),
    });

    const expiresAt = new Date(Date.now() + 86_400_000).toISOString();
    const link = CreateShareResponse.parse(
      (
        await post(owner, `/api/cairns/${cairnId}/shares`, {
          kind: 'link',
          role: 'editor',
          visibility: 'cited',
          expiresAt,
        }).expect(201)
      ).body,
    );
    expect(link.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(link.share).toMatchObject({ kind: 'link', email: null, role: 'editor', expiresAt });

    const list = ListSharesResponse.parse(
      (await get(owner, `/api/cairns/${cairnId}/shares`).expect(200)).body,
    );
    expect(list.shares.map((s) => s.id)).toEqual([email.share.id, link.share.id]);
    expect(JSON.stringify(list)).not.toContain(link.token);

    await del(owner, `/api/cairns/${cairnId}/shares/${email.share.id}`).expect(204);
    await del(owner, `/api/cairns/${cairnId}/shares/${email.share.id}`).expect(404);
    await del(owner, `/api/cairns/${cairnId}/shares/not-a-uuid`).expect(404);
    expect((await get(owner, `/api/cairns/${cairnId}/shares`)).body.shares).toHaveLength(1);
  });

  it('rejects bad requests with 400 and duplicates with 409', async () => {
    const { owner, cairnId } = await setup();
    const path = `/api/cairns/${cairnId}/shares`;

    await shareWith(owner, cairnId, 'not an email', 'viewer', 'cited').expect(400);
    await post(owner, path, { kind: 'link', role: 'owner', visibility: 'cited' }).expect(400);
    await post(owner, path, {
      kind: 'link',
      role: 'viewer',
      visibility: 'cited',
      expiresAt: 'soon',
    }).expect(400);
    const sealedEditor = await shareWith(owner, cairnId, 'a@b.co', 'editor', 'sealed').expect(400);
    expect(sealedEditor.body.error).toMatch(/must be cited/);
    await shareWith(owner, cairnId, 'owner@example.test', 'viewer', 'cited').expect(400);

    await shareWith(owner, cairnId, 'a@b.co', 'viewer', 'cited').expect(201);
    await shareWith(owner, cairnId, 'a@b.co', 'editor', 'cited').expect(409);
  });

  it('is owner-only: 401 signed out, 404 for strangers, 403 for grantees', async () => {
    const { owner, guest, cairnId } = await setup();
    const stranger = await person();
    const { body } = await shareWith(owner, cairnId, guest.user.email, 'editor', 'cited');
    const path = `/api/cairns/${cairnId}/shares`;

    await request(t.app).get(path).expect(401);
    await get(stranger, path).expect(404);
    await get(guest, path).expect(403);
    await shareWith(guest, cairnId, 'x@y.co', 'viewer', 'cited').expect(403);
    await del(guest, `${path}/${body.share.id}`).expect(403);
    await del(stranger, `${path}/${body.share.id}`).expect(404);
  });
});

describe('POST /api/share-links/:token/redeem', () => {
  it('needs sign-in, then gives the cairn; bad and revoked links are 404', async () => {
    const { owner, guest, cairnId } = await setup();
    const { body } = await post(owner, `/api/cairns/${cairnId}/shares`, {
      kind: 'link',
      role: 'viewer',
      visibility: 'sealed',
    });
    const token = body.token as string;

    await request(t.app)
      .post(`/api/share-links/${token}/redeem`)
      .set('Origin', APP_ORIGIN)
      .expect(401);
    await post(guest, `/api/share-links/${'x'.repeat(43)}/redeem`).expect(404);
    expect((await post(guest, `/api/share-links/${token}/redeem`).expect(200)).body).toEqual({
      cairnId,
    });

    const list = ListCairnsResponse.parse((await get(guest, '/api/cairns')).body);
    expect(list.cairns).toMatchObject([{ id: cairnId, role: 'viewer', visibility: 'sealed' }]);
    const shares = (await get(owner, `/api/cairns/${cairnId}/shares`)).body.shares;
    expect(shares[0].redeemedBy).toMatchObject([{ id: guest.user.id, email: guest.user.email }]);

    await del(owner, `/api/cairns/${cairnId}/shares/${body.share.id}`).expect(204);
    await post(guest, `/api/share-links/${token}/redeem`).expect(404);
    await get(guest, `/api/cairns/${cairnId}`).expect(404);
  });
});

describe('access by role and mode', () => {
  it('owners see their cairns as owner + cited', async () => {
    const { owner, cairnId } = await setup();
    expect((await get(owner, `/api/cairns/${cairnId}`)).body.cairn).toMatchObject({
      role: 'owner',
      visibility: 'cited',
    });
  });

  it('sealed viewers see the cairn but not its sources, and cannot ask yet', async () => {
    const { owner, guest, cairnId } = await setup();
    await shareWith(owner, cairnId, guest.user.email, 'viewer', 'sealed').expect(201);

    expect((await get(guest, `/api/cairns/${cairnId}`).expect(200)).body.cairn).toMatchObject({
      role: 'viewer',
      visibility: 'sealed',
    });
    const sources = await get(guest, `/api/cairns/${cairnId}/sources`).expect(403);
    expect(sources.body.error).toBe('sources are not shown for this cairn');
    await post(guest, `/api/cairns/${cairnId}/query`, { question: 'q?' }).expect(403);
  });

  it('cited viewers list sources but cannot add or delete them', async () => {
    const { owner, guest, cairnId, sourceId } = await setup();
    await shareWith(owner, cairnId, guest.user.email, 'viewer', 'cited').expect(201);

    expect(
      (await get(guest, `/api/cairns/${cairnId}/sources`).expect(200)).body.sources,
    ).toHaveLength(1);
    await request(t.app)
      .post(`/api/cairns/${cairnId}/sources`)
      .set('Cookie', guest.cookie)
      .set('Origin', APP_ORIGIN)
      .attach('file', Buffer.from('hi'), 'a.txt')
      .expect(403);
    await del(guest, `/api/cairns/${cairnId}/sources/${sourceId}`).expect(403);
    expect(t.storage.objects.size).toBe(0);
  });

  it('editors add sources but cannot delete them', async () => {
    const { owner, guest, cairnId, sourceId } = await setup();
    await shareWith(owner, cairnId, guest.user.email, 'editor', 'cited').expect(201);

    await request(t.app)
      .post(`/api/cairns/${cairnId}/sources`)
      .set('Cookie', guest.cookie)
      .set('Origin', APP_ORIGIN)
      .attach('file', Buffer.from('hi'), 'a.txt')
      .expect(202);
    const del403 = await del(guest, `/api/cairns/${cairnId}/sources/${sourceId}`).expect(403);
    expect(del403.body.error).toBe('only the owner can delete sources');
  });
});

describe('query rate limits with shares', () => {
  it('count per user and per share across everyone using a link', async () => {
    const { owner, guest, cairnId } = await setup();
    const other = await person();
    const { body } = await post(owner, `/api/cairns/${cairnId}/shares`, {
      kind: 'link',
      role: 'viewer',
      visibility: 'cited',
    });
    await post(guest, `/api/share-links/${body.token}/redeem`).expect(200);
    await post(other, `/api/share-links/${body.token}/redeem`).expect(200);
    // The source isn't ready, so each question is answered without the model.
    const ask = (who: Person) => post(who, `/api/cairns/${cairnId}/query`, { question: 'q?' });

    // Rate limits use fixed one-minute windows; don't let the test straddle two.
    vi.spyOn(Date, 'now').mockReturnValue(Date.now());
    // QUERY_RATE_LIMIT=3 per user, SHARE_QUERY_RATE_LIMIT=5 per share in tests.
    for (let i = 0; i < 3; i++) await ask(guest).expect(200);
    await ask(guest).expect(429);
    await ask(other).expect(200);
    await ask(other).expect(200);
    const limited = await ask(other).expect(429);
    expect(limited.headers['retry-after']).toMatch(/^\d+$/);
    // The owner isn't counted against the share.
    await ask(owner).expect(200);
  });
});
