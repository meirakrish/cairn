import { getUser, type Db } from '@cairn/core';
import type { NextFunction, Request, Response } from 'express';
import type { Config } from '../config';
import type { SessionStore } from './session';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

// CSRF: SameSite=Lax blocks cross-site cookies on POST; the Origin check covers same-site attackers.
export function originCheck(config: Config) {
  return (req: Request, res: Response, next: NextFunction) => {
    if (SAFE_METHODS.has(req.method) || req.headers.origin === config.appOrigin) return next();
    res.status(403).json({ error: 'bad origin' });
  };
}

// Loads req.user from the session cookie, if any.
export function loadUser(deps: { db: Db; sessions: SessionStore }) {
  return async (req: Request, _res: Response, next: NextFunction) => {
    const session = await deps.sessions.get(req);
    if (session) req.user = await getUser(deps.db, session.userId);
    next();
  };
}

export function requireUser(req: Request, res: Response, next: NextFunction) {
  if (req.user) return next();
  res.status(401).json({ error: 'not signed in' });
}
