import { createHash, randomBytes } from 'node:crypto';
import { parseCookie } from 'cookie';
import type { Request, Response } from 'express';
import type { Redis } from 'ioredis';
import type { Config } from '../config';

export const SESSION_COOKIE = 'cairn_sid';
const SESSION_TTL_SECONDS = 14 * 24 * 60 * 60;

interface SessionData {
  userId: string;
}

// Redis stores a hash of the session id, so a leaked Redis dump holds no usable cookies.
const key = (sid: string) => `session:${createHash('sha256').update(sid).digest('base64url')}`;

export function readCookie(req: Request, name: string): string | undefined {
  return req.headers.cookie ? parseCookie(req.headers.cookie)[name] : undefined;
}

export class SessionStore {
  constructor(
    private redis: Redis,
    private config: Config,
  ) {}

  async create(res: Response, data: SessionData): Promise<void> {
    const sid = randomBytes(32).toString('base64url');
    await this.redis.set(key(sid), JSON.stringify(data), 'EX', SESSION_TTL_SECONDS);
    res.cookie(SESSION_COOKIE, sid, {
      httpOnly: true,
      sameSite: 'lax',
      secure: this.config.secureCookies,
      path: '/',
      maxAge: SESSION_TTL_SECONDS * 1000,
    });
  }

  async get(req: Request): Promise<SessionData | undefined> {
    const sid = readCookie(req, SESSION_COOKIE);
    if (!sid) return undefined;
    const raw = await this.redis.get(key(sid));
    return raw ? (JSON.parse(raw) as SessionData) : undefined;
  }

  async destroy(req: Request, res: Response): Promise<void> {
    const sid = readCookie(req, SESSION_COOKIE);
    if (sid) await this.redis.del(key(sid));
    res.clearCookie(SESSION_COOKIE, { path: '/' });
  }
}
