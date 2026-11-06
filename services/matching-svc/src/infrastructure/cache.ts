import { type MatchCache } from '../application/ports';

/** In-process TTL cache for ranked results (per requisition, calibration and weights_version). */
export class MemoryMatchCache implements MatchCache {
  private readonly entries = new Map<string, { value: unknown; expires: number }>();

  constructor(
    private readonly now: () => number = Date.now,
    private readonly maxEntries = 1000,
  ) {}

  get<T>(key: string): T | undefined {
    const hit = this.entries.get(key);
    if (!hit) return undefined;
    if (hit.expires <= this.now()) {
      this.entries.delete(key);
      return undefined;
    }
    return hit.value as T;
  }

  set<T>(key: string, value: T, ttlSeconds: number): void {
    if (this.entries.size >= this.maxEntries) {
      const oldest = this.entries.keys().next().value;
      if (oldest !== undefined) this.entries.delete(oldest);
    }
    this.entries.set(key, { value, expires: this.now() + ttlSeconds * 1000 });
  }

  evictPrefix(prefix: string): void {
    for (const key of [...this.entries.keys()])
      if (key.startsWith(prefix)) this.entries.delete(key);
  }
}
