import { type Logger } from 'pino';
import { type RateLimitDecision, type RateLimiter } from './rate-limit';

/** The subset of an ioredis client this limiter needs. */
export interface RedisEvalClient {
  eval(script: string, numKeys: number, ...args: (string | number)[]): Promise<unknown>;
}

// Atomic fixed window: the first hit sets the expiry, so concurrent replicas share one counter.
const SCRIPT = `
local hits = redis.call('INCR', KEYS[1])
if hits == 1 then redis.call('PEXPIRE', KEYS[1], ARGV[1]) end
local ttl = redis.call('PTTL', KEYS[1])
if ttl < 0 then redis.call('PEXPIRE', KEYS[1], ARGV[1]); ttl = tonumber(ARGV[1]) end
return {hits, ttl}
`;

/**
 * Shared limiter for every replica. If Redis is unreachable it lets the request through and
 * logs an error: limits protect against abuse, while the secrets themselves carry 256 bits of
 * entropy, so an outage should not lock every user out.
 */
export class RedisRateLimiter implements RateLimiter {
  constructor(
    private readonly redis: RedisEvalClient,
    private readonly logger?: Logger,
    private readonly prefix = 'atlas:rl:',
  ) {}

  async consume(key: string, limit: number, windowSec: number): Promise<RateLimitDecision> {
    try {
      const result = (await this.redis.eval(SCRIPT, 1, this.prefix + key, windowSec * 1000)) as [
        number,
        number,
      ];
      const [hits, ttlMs] = result;
      return {
        allowed: Number(hits) <= limit,
        retryAfterSec: Math.max(1, Math.ceil(Number(ttlMs) / 1000)),
      };
    } catch (error) {
      this.logger?.error(
        { err: error, key: this.prefix + key },
        'rate limiter unavailable; allowing',
      );
      return { allowed: true, retryAfterSec: 0 };
    }
  }
}
