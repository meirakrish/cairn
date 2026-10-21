import { randomUUID } from 'node:crypto';
import type { Redis } from 'ioredis';

// Drop expired leases, then admit the stream only if the user is under the limit. One script, so
// two streams opening at once can't both see room for one.
const ACQUIRE = `
redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', ARGV[2])
if redis.call('ZCARD', KEYS[1]) >= tonumber(ARGV[3]) then return 0 end
redis.call('ZADD', KEYS[1], ARGV[1], ARGV[4])
redis.call('PEXPIRE', KEYS[1], ARGV[5])
return 1
`;

// XX: only a lease that is still there; one dropped as expired stays dropped.
const RENEW = `
redis.call('ZADD', KEYS[1], 'XX', ARGV[1], ARGV[2])
redis.call('PEXPIRE', KEYS[1], ARGV[3])
`;

/** A held slot for one open stream: renew it on every heartbeat, release it on close. */
export interface StreamLease {
  renew(): Promise<void>;
  release(): Promise<void>;
}

/**
 * Caps how many event streams one user can hold open, across api processes. Each stream is a
 * member of a Redis sorted set scored by its last renewal; a lease not renewed within `leaseMs`
 * (a crashed process, a lost connection) stops counting, so nobody stays locked out.
 */
export class StreamLimiter {
  constructor(
    private redis: Redis,
    private opts: { limit: number; leaseMs: number },
  ) {}

  private key(userId: string) {
    return `sse:streams:${userId}`;
  }

  /** A lease, or undefined when the user already has `limit` streams open. */
  async acquire(userId: string): Promise<StreamLease | undefined> {
    const key = this.key(userId);
    const id = randomUUID();
    const now = Date.now();
    const ok = await this.redis.eval(
      ACQUIRE,
      1,
      key,
      now,
      now - this.opts.leaseMs,
      this.opts.limit,
      id,
      this.opts.leaseMs,
    );
    if (ok !== 1) return undefined;

    let released = false;
    return {
      renew: async () => {
        if (released) return;
        // A script rather than multi(): its queued commands reject unhandled if the connection drops.
        await this.redis.eval(RENEW, 1, key, Date.now(), id, this.opts.leaseMs);
      },
      release: async () => {
        if (released) return;
        released = true;
        await this.redis.zrem(key, id);
      },
    };
  }
}
