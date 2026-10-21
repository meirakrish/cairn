import type { CairnAccess } from '@cairn/core';
import type { Response } from 'express';
import type { Redis } from 'ioredis';
import type { Config } from './config';
import { HttpError } from './errors';

/**
 * Fixed-window counter in Redis: at most `limit` hits per `windowSeconds` per key.
 * Returns 0 when allowed, else the seconds until the window resets.
 */
export async function rateLimit(
  redis: Redis,
  key: string,
  limit: number,
  windowSeconds: number,
): Promise<number> {
  const window = Math.floor(Date.now() / 1000 / windowSeconds);
  const redisKey = `ratelimit:${key}:${window}`;
  const [[, count]] = (await redis
    .multi()
    .incr(redisKey)
    .expire(redisKey, windowSeconds)
    .exec()) as [[Error | null, number]];
  if (count <= limit) return 0;
  return windowSeconds - (Math.floor(Date.now() / 1000) % windowSeconds);
}

/**
 * The limits on model calls about a cairn (questions, quiz questions, graded answers): per user, and
 * for share callers also per share (a link can reach many people). Over a limit: 429 + Retry-After.
 */
export async function limitQuestions(
  redis: Redis,
  config: Config,
  userId: string,
  access: CairnAccess,
  res: Response,
): Promise<void> {
  const retryAfter =
    (await rateLimit(redis, `query:user:${userId}`, config.queryRateLimit, 60)) ||
    (access.shareId
      ? await rateLimit(redis, `query:share:${access.shareId}`, config.shareQueryRateLimit, 60)
      : 0);
  if (retryAfter) {
    res.setHeader('Retry-After', String(retryAfter));
    throw new HttpError(429, `too many questions; try again in ${retryAfter} s`);
  }
}
