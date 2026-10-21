import {
  createDb,
  EMBEDDING_DIMENSIONS,
  IngestQueue,
  MemoryObjectStore,
  redisSourcePublisher,
  SourceService,
} from '@cairn/core';
import { createUser, resetDb, testEnv } from '@cairn/core/testing';
import type { LlmClient } from '@meirakrish/llm-kit';
import { fakeEmbedder, scriptedLlm, type ScriptedLlmScript } from '@meirakrish/llm-kit/testing';
import { Redis } from 'ioredis';
import type { Response } from 'supertest';
import { createApp } from './app';
import { EventHub } from './event-hub';
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
    // Tests use MemoryObjectStore; these only satisfy the config schema.
    S3_ENDPOINT: 'http://s3.invalid',
    S3_REGION: 'test',
    S3_BUCKET: 'test',
    S3_ACCESS_KEY_ID: 'test',
    S3_SECRET_ACCESS_KEY: 'test',
    UPLOAD_MAX_MEGA_BYTES: '1',
    SSE_HEARTBEAT_MS: '50',
    QUERY_RATE_LIMIT: '3',
    SHARE_QUERY_RATE_LIMIT: '5',
    // Background writes would take scripted answers meant for the test.
    QUIZ_PREFETCH: '0',
  });
  const admin = createDb(env.adminUrl);
  const db = createDb(config.databaseUrl);
  const redis = new Redis(config.redisUrl);
  const sessions = new SessionStore(redis, config);
  const storage = new MemoryObjectStore();
  const ingest = new IngestQueue(redis);
  const subscriber = new Redis(config.redisUrl);
  const hub = new EventHub(subscriber);
  const embedder = fakeEmbedder({ dimensions: EMBEDDING_DIMENSIONS });
  // Tests replace the script with t.script(...); the app keeps talking to this wrapper.
  let llm = scriptedLlm();
  const llmProxy: LlmClient = {
    provider: 'custom',
    model: 'scripted',
    chatWithTools: (...args) => llm.chatWithTools(...args),
    structured: (...args) => llm.structured(...args),
    stream: (...args) => llm.stream(...args),
    takeUsage: () => llm.takeUsage(),
  };

  return {
    app: createApp({ config, db: db.db, redis, storage, ingest, hub, embedder, llm: llmProxy }),
    config,
    storage,
    ingest,
    hub,
    embedder,
    /** Sets what the model answers next; returns the scripted client to inspect its calls. */
    script(next: ScriptedLlmScript) {
      llm = scriptedLlm(next);
      return llm;
    },
    // Acts like the worker: changes made through it are published to the event streams.
    sources: new SourceService(db.db, { onChange: redisSourcePublisher(redis) }),
    admin: admin.db,
    redis,
    async reset() {
      await resetDb(admin.db);
      await redis.flushdb();
      storage.objects.clear();
    },
    createUser: (overrides?: Parameters<typeof createUser>[1]) => createUser(admin.db, overrides),
    // A Cookie header value for a signed-in user.
    async signIn(userId: string) {
      return `cairn_sid=${await sessions.start({ userId })}`;
    },
    async close() {
      await ingest.close();
      await Promise.all([admin.close(), db.close(), redis.quit(), subscriber.quit()]);
    },
  };
}

// The value a response sets for a cookie, or undefined if it doesn't set it.
export function setCookie(res: Response, name: string): string | undefined {
  const header = res.headers['set-cookie'] as unknown as string[] | undefined;
  const cookie = header?.find((c) => c.startsWith(`${name}=`));
  return cookie?.slice(name.length + 1).split(';')[0];
}
