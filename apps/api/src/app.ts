import {
  CairnService,
  NotFoundError,
  SourceService,
  type Db,
  type IngestQueue,
  type ObjectStore,
} from '@cairn/core';
import type { HealthResponse } from '@cairn/shared';
import express, { type ErrorRequestHandler } from 'express';
import type { Redis } from 'ioredis';
import { z } from 'zod';
import { authRouter } from './auth';
import { loadUser, originCheck } from './auth/middleware';
import { SessionStore } from './auth/session';
import { cairnsRouter } from './cairns';
import type { Config } from './config';
import { HttpError } from './errors';

export interface AppDeps {
  config: Config;
  db: Db;
  redis: Redis;
  storage: ObjectStore;
  ingest: IngestQueue;
}

export function createApp({ config, db, redis, storage, ingest }: AppDeps) {
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
  app.use(
    '/api/cairns',
    cairnsRouter({
      config,
      cairns: new CairnService(db, config.embedModel),
      sources: new SourceService(db),
      storage,
      ingest,
    }),
  );

  app.use('/api', (_req, res) => {
    res.status(404).json({ error: 'not found' });
  });
  app.use(errorHandler);

  return app;
}

const errorHandler: ErrorRequestHandler = (err, _req, res, _next) => {
  if (err instanceof HttpError) {
    res.status(err.status).json({ error: err.message });
    return;
  }
  if (err instanceof NotFoundError) {
    res.status(404).json({ error: err.message });
    return;
  }
  if (err instanceof z.ZodError) {
    res.status(400).json({ error: 'invalid request', issues: z.flattenError(err).fieldErrors });
    return;
  }
  // body-parser errors (bad JSON, too large) carry a 4xx status.
  if (typeof err?.status === 'number' && err.status < 500) {
    res.status(err.status).json({ error: err.expose ? err.message : 'bad request' });
    return;
  }
  console.error(err);
  res.status(500).json({ error: 'internal error' });
};
