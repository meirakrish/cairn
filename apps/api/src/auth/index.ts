import type { Db } from '@cairn/core';
import type { MeResponse } from '@cairn/shared';
import { Router } from 'express';
import type { Redis } from 'ioredis';
import type { Config } from '../config';
import { googleAuthRouter } from './google';
import { requireUser } from './middleware';
import type { SessionStore } from './session';

export function authRouter(deps: { config: Config; db: Db; redis: Redis; sessions: SessionStore }) {
  const router = Router();
  router.use('/google', googleAuthRouter(deps));

  router.get('/me', requireUser, (req, res) => {
    const { id, email, name, avatarUrl } = req.user!;
    const body: MeResponse = { user: { id, email, name, avatarUrl } };
    res.json(body);
  });

  router.post('/logout', async (req, res) => {
    await deps.sessions.destroy(req, res);
    res.status(204).end();
  });

  return router;
}
