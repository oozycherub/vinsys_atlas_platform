import { type Clock } from '@atlas/platform';

/** A tenant-directory entry (tenant-svc `GET /v1/tenant-directory:resolve`). */
export interface DirectoryEntry {
  tenant_id: string;
  cell_id: string;
  data_region: string;
  isolation_tier: 'pooled' | 'dedicated';
  status: 'provisioning' | 'active' | 'suspended' | 'offboarding' | 'purged';
}

export interface DirectorySource {
  /** null when the slug is unknown; throws when the directory cannot answer. */
  resolve(slug: string): Promise<DirectoryEntry | null>;
}

export const POSITIVE_TTL_MS = 60_000;
export const NEGATIVE_TTL_MS = 10_000;

/**
 * Slug → directory entry, cached 60 s (unknown slugs 10 s) with one lookup in flight per slug.
 * When the directory is down, a stale entry is served for up to `staleMs` rather than failing
 * every request of a known tenant.
 */
export class TenantResolver {
  private readonly cache = new Map<
    string,
    { entry: DirectoryEntry | null; until: number; storedAt: number }
  >();
  private readonly inflight = new Map<string, Promise<DirectoryEntry | null>>();

  constructor(
    private readonly source: DirectorySource,
    private readonly clock: Clock,
    private readonly staleMs = 5 * 60_000,
    private readonly maxEntries = 10_000,
  ) {}

  async resolve(slug: string): Promise<DirectoryEntry | null> {
    const now = this.clock.now().getTime();
    const hit = this.cache.get(slug);
    if (hit && hit.until > now) return hit.entry;
    const pending = this.inflight.get(slug);
    if (pending) return pending;
    const lookup = this.source
      .resolve(slug)
      .then((entry) => {
        if (this.cache.size >= this.maxEntries)
          this.cache.delete(this.cache.keys().next().value as string);
        const at = this.clock.now().getTime();
        this.cache.set(slug, {
          entry,
          until: at + (entry ? POSITIVE_TTL_MS : NEGATIVE_TTL_MS),
          storedAt: at,
        });
        return entry;
      })
      .catch((error: unknown) => {
        if (hit?.entry && now - hit.storedAt < this.staleMs) return hit.entry;
        throw error;
      })
      .finally(() => this.inflight.delete(slug));
    this.inflight.set(slug, lookup);
    return lookup;
  }
}

/** tenant-svc over HTTP with a service token (scope tenant-directory:read). */
export class HttpDirectorySource implements DirectorySource {
  constructor(
    private readonly o: {
      baseUrl: string;
      token: () => Promise<string>;
      fetch?: typeof fetch;
      timeoutMs?: number;
    },
  ) {}

  async resolve(slug: string): Promise<DirectoryEntry | null> {
    const res = await (this.o.fetch ?? fetch)(
      `${this.o.baseUrl.replace(/\/$/, '')}/v1/tenant-directory:resolve?slug=${encodeURIComponent(slug)}`,
      {
        headers: { Authorization: `Bearer ${await this.o.token()}` },
        signal: AbortSignal.timeout(this.o.timeoutMs ?? 2000),
      },
    );
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`tenant directory: HTTP ${res.status}`);
    return (await res.json()) as DirectoryEntry;
  }
}
