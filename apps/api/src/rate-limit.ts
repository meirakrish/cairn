import type { Redis } from 'ioredis';

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
