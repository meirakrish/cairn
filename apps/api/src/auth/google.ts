import { randomBytes } from 'node:crypto';
import { upsertGoogleUser, type Db } from '@cairn/core';
import { Router } from 'express';
import { CodeChallengeMethod, OAuth2Client } from 'google-auth-library';
import type { Redis } from 'ioredis';
import type { Config } from '../config';
import { readCookie, type SessionStore } from './session';

// Short-lived cookie that ties the OAuth state to this browser (prevents login CSRF).
const STATE_COOKIE = 'cairn_oauth_state';
const STATE_TTL_SECONDS = 10 * 60;

interface PendingLogin {
  codeVerifier: string;
  nonce: string;
  /** Where to land after signing in, e.g. a share link (/s/<token>). */
  returnTo?: string;
}

// Only a path on this site: no other origin ("//evil", "/\\evil"), nothing under /api.
function safeReturnTo(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length > 200) return undefined;
  if (!/^\/(?![/\\])[A-Za-z0-9\-._~/?=&%]*$/.test(value)) return undefined;
  if (value === '/api' || value.startsWith('/api/')) return undefined;
  return value;
}

export function googleAuthRouter(deps: {
  config: Config;
  db: Db;
  redis: Redis;
  sessions: SessionStore;
}) {
  const { config, db, redis, sessions } = deps;
  const client = new OAuth2Client({
    clientId: config.google.clientId,
    clientSecret: config.google.clientSecret,
    redirectUri: config.google.redirectUri,
  });
  const stateKey = (state: string) => `oauth:state:${state}`;
  const router = Router();

  // ?returnTo=/s/<token> brings the user back there after signing in.
  router.get('/start', async (req, res) => {
    const state = randomBytes(24).toString('base64url');
    const nonce = randomBytes(24).toString('base64url');
    const { codeVerifier, codeChallenge } = await client.generateCodeVerifierAsync();
    const pending: PendingLogin = {
      codeVerifier,
      nonce,
      returnTo: safeReturnTo(req.query.returnTo),
    };
    await redis.set(stateKey(state), JSON.stringify(pending), 'EX', STATE_TTL_SECONDS);

    res.cookie(STATE_COOKIE, state, {
      httpOnly: true,
      sameSite: 'lax',
      secure: config.secureCookies,
      path: '/api/auth/google',
      maxAge: STATE_TTL_SECONDS * 1000,
    });
    res.redirect(
      client.generateAuthUrl({
        scope: ['openid', 'email', 'profile'],
        state,
        nonce,
        code_challenge_method: CodeChallengeMethod.S256,
        code_challenge: codeChallenge,
        prompt: 'select_account',
      }),
    );
  });

  router.get('/callback', async (req, res) => {
    const fail = (reason: string, err?: unknown) => {
      console.warn(`google login failed: ${reason}`, err ?? '');
      res.redirect('/?login=failed');
    };

    const { code, state } = req.query;
    const cookieState = readCookie(req, STATE_COOKIE);
    res.clearCookie(STATE_COOKIE, { path: '/api/auth/google' });
    if (typeof code !== 'string' || typeof state !== 'string') return fail('missing code or state');
    if (state !== cookieState) return fail('state mismatch');

    // getdel makes each state single-use.
    const raw = await redis.getdel(stateKey(state));
    if (!raw) return fail('unknown or expired state');
    const pending = JSON.parse(raw) as PendingLogin;

    try {
      const { tokens } = await client.getToken({ code, codeVerifier: pending.codeVerifier });
      if (!tokens.id_token) return fail('no id_token');
      const ticket = await client.verifyIdToken({
        idToken: tokens.id_token,
        audience: config.google.clientId,
      });
      const p = ticket.getPayload();
      if (!p || p.nonce !== pending.nonce) return fail('nonce mismatch');
      if (!p.email || !p.email_verified) return fail('email not verified');

      const user = await upsertGoogleUser(db, {
        sub: p.sub,
        email: p.email,
        name: p.name ?? null,
        avatarUrl: p.picture ?? null,
      });
      // Rotate: the old session dies and the new cookie replaces it.
      await sessions.revoke(req);
      await sessions.create(res, { userId: user.id });
      res.redirect(pending.returnTo ?? '/');
    } catch (err) {
      fail('token exchange or verification error', err);
    }
  });

  return router;
}
