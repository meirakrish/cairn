import { users } from '@cairn/core';
import { OAuth2Client, type TokenPayload } from 'google-auth-library';
import request from 'supertest';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { APP_ORIGIN, createTestApp, setCookie } from './testing';

const t = createTestApp();

beforeEach(async () => {
  await t.reset();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());
afterAll(() => t.close());

describe('session', () => {
  it('/me is 401 without a session or with an unknown one', async () => {
    await request(t.app).get('/api/auth/me').expect(401);
    await request(t.app).get('/api/auth/me').set('Cookie', 'cairn_sid=nope').expect(401);
  });

  it('/me returns the signed-in user', async () => {
    const user = await t.createUser({ name: 'Ada' });
    const res = await request(t.app)
      .get('/api/auth/me')
      .set('Cookie', await t.signIn(user.id))
      .expect(200);

    expect(res.body).toEqual({
      user: { id: user.id, email: user.email, name: 'Ada', avatarUrl: null },
    });
  });

  it('logout needs the app origin, then ends the session', async () => {
    const cookie = await t.signIn((await t.createUser()).id);

    await request(t.app).post('/api/auth/logout').set('Cookie', cookie).expect(403);
    await request(t.app).get('/api/auth/me').set('Cookie', cookie).expect(200);

    const res = await request(t.app)
      .post('/api/auth/logout')
      .set('Cookie', cookie)
      .set('Origin', APP_ORIGIN)
      .expect(204);
    expect(setCookie(res, 'cairn_sid')).toBe('');
    await request(t.app).get('/api/auth/me').set('Cookie', cookie).expect(401);
  });
});

describe('google login', () => {
  async function start() {
    const res = await request(t.app).get('/api/auth/google/start').expect(302);
    const location = new URL(res.headers.location!);
    const state = location.searchParams.get('state')!;
    return { res, location, state, nonce: location.searchParams.get('nonce')! };
  }

  function mockGoogle(payload: Partial<TokenPayload>) {
    const getToken = vi
      .spyOn(OAuth2Client.prototype, 'getToken')
      .mockResolvedValue({ tokens: { id_token: 'id-token' } } as never);
    vi.spyOn(OAuth2Client.prototype, 'verifyIdToken').mockResolvedValue({
      getPayload: () => payload,
    } as never);
    return getToken;
  }

  function callback(state: string, cookieState = state, cookie = '') {
    return request(t.app)
      .get('/api/auth/google/callback')
      .query({ code: 'auth-code', state })
      .set('Cookie', [`cairn_oauth_state=${cookieState}`, cookie].filter(Boolean).join('; '));
  }

  const profile = (nonce: string): Partial<TokenPayload> => ({
    sub: 'google-sub-1',
    email: 'ada@example.test',
    email_verified: true,
    name: 'Ada',
    picture: 'https://example.test/ada.png',
    nonce,
  });

  it('start redirects to Google with PKCE and binds the state to the browser', async () => {
    const { res, location, state } = await start();

    expect(location.origin).toBe('https://accounts.google.com');
    expect(location.searchParams.get('client_id')).toBe('test-client-id');
    expect(location.searchParams.get('redirect_uri')).toBe(
      `${APP_ORIGIN}/api/auth/google/callback`,
    );
    expect(location.searchParams.get('code_challenge_method')).toBe('S256');
    expect(location.searchParams.get('code_challenge')).toBeTruthy();
    expect(setCookie(res, 'cairn_oauth_state')).toBe(state);
    expect(await t.redis.exists(`oauth:state:${state}`)).toBe(1);
  });

  it('callback signs the user in and creates the user', async () => {
    const { state, nonce } = await start();
    const getToken = mockGoogle(profile(nonce));

    const res = await callback(state).expect(302);
    expect(res.headers.location).toBe('/');
    expect(getToken).toHaveBeenCalledWith(
      expect.objectContaining({ code: 'auth-code', codeVerifier: expect.any(String) }),
    );

    const header = res.headers['set-cookie'] as unknown as string[];
    expect(header.filter((c) => c.startsWith('cairn_sid='))).toHaveLength(1);
    const sid = setCookie(res, 'cairn_sid');
    expect(sid).toBeTruthy();
    const me = await request(t.app).get('/api/auth/me').set('Cookie', `cairn_sid=${sid}`);
    expect(me.body.user).toMatchObject({ email: 'ada@example.test', name: 'Ada' });

    const rows = await t.admin.select().from(users);
    expect(rows).toMatchObject([{ googleSub: 'google-sub-1', email: 'ada@example.test' }]);
  });

  it('a new login replaces the existing session', async () => {
    const old = await t.signIn((await t.createUser()).id);
    const { state, nonce } = await start();
    mockGoogle(profile(nonce));

    await callback(state, state, old).expect(302);
    await request(t.app).get('/api/auth/me').set('Cookie', old).expect(401);
  });

  it('rejects a state that does not match the browser cookie, before talking to Google', async () => {
    const { state, nonce } = await start();
    const getToken = mockGoogle(profile(nonce));

    const res = await callback(state, 'other-state').expect(302);
    expect(res.headers.location).toBe('/?login=failed');
    expect(getToken).not.toHaveBeenCalled();
  });

  it('accepts each state only once', async () => {
    const { state, nonce } = await start();
    mockGoogle(profile(nonce));

    await callback(state).expect(302);
    const replay = await callback(state).expect(302);
    expect(replay.headers.location).toBe('/?login=failed');
    expect(setCookie(replay, 'cairn_sid')).toBeUndefined();
  });

  it('rejects an ID token with the wrong nonce', async () => {
    const { state } = await start();
    mockGoogle(profile('wrong-nonce'));

    const res = await callback(state).expect(302);
    expect(res.headers.location).toBe('/?login=failed');
    expect(setCookie(res, 'cairn_sid')).toBeUndefined();
  });

  it('rejects an unverified email', async () => {
    const { state, nonce } = await start();
    mockGoogle({ ...profile(nonce), email_verified: false });

    const res = await callback(state).expect(302);
    expect(res.headers.location).toBe('/?login=failed');
    expect(await t.admin.select().from(users)).toEqual([]);
  });
});
