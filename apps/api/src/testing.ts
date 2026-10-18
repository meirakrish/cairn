import { createDb } from '@cairn/core';
import { createUser, resetDb, testEnv } from '@cairn/core/testing';
import { Redis } from 'ioredis';
import type { Response } from 'supertest';
import { createApp } from './app';
import { SessionStore } from './auth/session';
import { loadConfig } from './config';

export const APP_ORIGIN = 'http://localhost:5173';

// The real app wired to the test database and Redis db, plus fixtures.
export function createTestApp() {
  const env = testEnv();
  const config = loadConfig({
    DATABASE_URL: env.appUrl,
    REDIS_URL: env.redisUrl,
    APP_ORIGIN,
    GOOGLE_CLIENT_ID: 'test-client-id',
    GOOGLE_CLIENT_SECRET: 'test-client-secret',
  });
  const admin = createDb(env.adminUrl);
  const db = createDb(config.databaseUrl);
  const redis = new Redis(config.redisUrl);
  const sessions = new SessionStore(redis, config);

  return {
    app: createApp({ config, db: db.db, redis }),
    config,
    admin: admin.db,
    redis,
    async reset() {
      await resetDb(admin.db);
      await redis.flushdb();
    },
    createUser: (overrides?: Parameters<typeof createUser>[1]) => createUser(admin.db, overrides),
    // A Cookie header value for a signed-in user.
    async signIn(userId: string) {
      return `cairn_sid=${await sessions.start({ userId })}`;
    },
    async close() {
      await Promise.all([admin.close(), db.close(), redis.quit()]);
    },
  };
}

// The value a response sets for a cookie, or undefined if it doesn't set it.
export function setCookie(res: Response, name: string): string | undefined {
  const header = res.headers['set-cookie'] as unknown as string[] | undefined;
  const cookie = header?.find((c) => c.startsWith(`${name}=`));
  return cookie?.slice(name.length + 1).split(';')[0];
}
