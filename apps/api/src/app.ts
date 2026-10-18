import type { Db } from '@cairn/core';
import type { HealthResponse } from '@cairn/shared';
import express from 'express';
import type { Redis } from 'ioredis';
import { authRouter } from './auth';
import { loadUser, originCheck } from './auth/middleware';
import { SessionStore } from './auth/session';
import type { Config } from './config';

export interface AppDeps {
  config: Config;
  db: Db;
  redis: Redis;
}

export function createApp({ config, db, redis }: AppDeps) {
  const sessions = new SessionStore(redis, config);
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '100kb' }));
  app.use(originCheck(config));
  app.use(loadUser({ db, sessions }));

  app.get('/api/health', (_req, res) => {
    const body: HealthResponse = { status: 'ok' };
    res.json(body);
  });
  app.use('/api/auth', authRouter({ config, db, redis, sessions }));

  return app;
}
