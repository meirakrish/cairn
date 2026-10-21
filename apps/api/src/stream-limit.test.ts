import { testEnv } from '@cairn/core/testing';
import { Redis } from 'ioredis';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { StreamLimiter } from './stream-limit';

const redis = new Redis(testEnv().redisUrl);

beforeEach(async () => {
  await redis.flushdb();
});
afterAll(() => redis.quit());

describe('StreamLimiter', () => {
  it('admits up to the limit per user, and frees a slot on release', async () => {
    const limiter = new StreamLimiter(redis, { limit: 2, leaseMs: 60_000 });
    const a = await limiter.acquire('u1');
    const b = await limiter.acquire('u1');
    expect(a && b).toBeTruthy();
    expect(await limiter.acquire('u1')).toBeUndefined();
    expect(await limiter.acquire('u2')).toBeDefined();

    await a!.release();
    await a!.release(); // idempotent: doesn't free a second slot
    expect(await limiter.acquire('u1')).toBeDefined();
    expect(await limiter.acquire('u1')).toBeUndefined();
  });

  it('stops counting leases that are not renewed in time', async () => {
    const limiter = new StreamLimiter(redis, { limit: 1, leaseMs: 100 });
    const stale = await limiter.acquire('u1');
    expect(await limiter.acquire('u1')).toBeUndefined();

    await new Promise((r) => setTimeout(r, 150));
    expect(await limiter.acquire('u1')).toBeDefined();
    // A renewal after expiry doesn't bring the stale lease back.
    await stale!.renew();
    expect(await redis.zcard('sse:streams:u1')).toBe(1);
  });

  it('keeps renewed leases', async () => {
    const limiter = new StreamLimiter(redis, { limit: 1, leaseMs: 150 });
    const lease = await limiter.acquire('u1');
    for (let i = 0; i < 3; i++) {
      await new Promise((r) => setTimeout(r, 80));
      await lease!.renew();
    }
    expect(await limiter.acquire('u1')).toBeUndefined();
  });

  it('admits exactly the limit when streams open at the same time', async () => {
    const limiter = new StreamLimiter(redis, { limit: 3, leaseMs: 60_000 });
    const leases = await Promise.all(Array.from({ length: 10 }, () => limiter.acquire('u1')));
    expect(leases.filter(Boolean)).toHaveLength(3);
  });
});
