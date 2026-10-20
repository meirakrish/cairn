import {
  AnswerService,
  CairnService,
  NotFoundError,
  RetrievalService,
  redisSourcePublisher,
  SourceService,
  type Db,
  type IngestQueue,
  type ObjectStore,
} from '@cairn/core';
import type { HealthResponse } from '@cairn/shared';
import express, { type ErrorRequestHandler } from 'express';
import type { Embedder, LlmClient } from '@meirakrish/llm-kit';
import type { Redis } from 'ioredis';
import { z } from 'zod';
import { authRouter } from './auth';
import { loadUser, originCheck } from './auth/middleware';
import { SessionStore } from './auth/session';
import { cairnsRouter } from './cairns';
import type { EventHub } from './event-hub';
import { eventsRouter } from './events';
import { queryRouter } from './query';
import type { Config } from './config';
import { HttpError } from './errors';

export interface AppDeps {
  config: Config;
  db: Db;
  redis: Redis;
  storage: ObjectStore;
  ingest: IngestQueue;
  /** Fans out live updates to event streams; needs its own Redis connection in subscriber mode. */
  hub: EventHub;
  /** Embeds questions for retrieval; must match the worker's model (EMBED_MODEL). */
  embedder: Embedder;
  /** Writes the answers. */
  llm: LlmClient;
}

export function createApp({ config, db, redis, storage, ingest, hub, embedder, llm }: AppDeps) {
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
  const cairns = new CairnService(db, config.embedModel);
  const sources = new SourceService(db, { onChange: redisSourcePublisher(redis) });
  const answers = new AnswerService(db, new RetrievalService(db, embedder), llm);
  app.use('/api/cairns', eventsRouter({ config, cairns, sources, sessions, hub }));
  app.use('/api/cairns', queryRouter({ config, cairns, answers, redis }));
  app.use('/api/cairns', cairnsRouter({ config, cairns, sources, storage, ingest }));

  app.use('/api', (_req, res) => {
    res.status(404).json({ error: 'not found' });
  });
  app.use(errorHandler);

  return app;
}

const errorHandler: ErrorRequestHandler = (err, _req, res, _next) => {
  // A stream (SSE) that fails after it started can't change its status; just end it.
  if (res.headersSent) {
    console.error(err);
    res.end();
    return;
  }
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
