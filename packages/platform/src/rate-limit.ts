import { type Clock } from './clock';

export interface RateLimitDecision {
  allowed: boolean;
  /** Seconds until the window resets; meaningful when `allowed` is false. */
  retryAfterSec: number;
}

/** Fixed-window limiter. Production backs it with Redis so every replica shares the counters. */
export interface RateLimiter {
  consume(key: string, limit: number, windowSec: number): Promise<RateLimitDecision>;
}

export const RATE_LIMITER = Symbol('RATE_LIMITER');

/**
 * Single-process limiter for development and tests. Counters are per replica, so it is refused
 * in production by service config (see each service's README).
 */
export class MemoryRateLimiter implements RateLimiter {
  private readonly windows = new Map<string, { startedAt: number; count: number }>();

  constructor(private readonly clock: Clock) {}

  consume(key: string, limit: number, windowSec: number): Promise<RateLimitDecision> {
    const now = this.clock.now().getTime();
    const windowMs = windowSec * 1000;
    let window = this.windows.get(key);
    if (!window || now - window.startedAt >= windowMs) {
      window = { startedAt: now, count: 0 };
      this.windows.set(key, window);
    }
    window.count += 1;
    const retryAfterSec = Math.ceil((window.startedAt + windowMs - now) / 1000);
    return Promise.resolve({ allowed: window.count <= limit, retryAfterSec });
  }
}
