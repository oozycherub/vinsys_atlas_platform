import { type Database, withTenantTx } from '@atlas/platform';
import { type LexicalHit, type LexicalIndex, UpstreamError } from '../application/ports';
import { type CandidateFeatures } from '../domain/features';

/**
 * Postgres full-text ranking over the read model (`ts_rank_cd` on profile_tsv), for development
 * and small tenants. LEX is normalised by the best score in the result set, so the ranking
 * function's scale does not matter, only its order. Runs in the tenant's transaction (RLS).
 */
export class PgLexicalIndex implements LexicalIndex {
  constructor(private readonly db: Database) {}

  async search(
    tenantId: string,
    query: string,
    o: { k: number; candidateIds?: string[] },
  ): Promise<LexicalHit[]> {
    if (!query.trim()) return [];
    return withTenantTx(this.db, tenantId, async (tx) => {
      const { rows } = await tx.query<{ candidate_id: string; rank: number }>(
        `WITH q AS (SELECT websearch_to_tsquery('english', $1) AS q)
         SELECT f.candidate_id::text, ts_rank_cd(f.profile_tsv, q.q, 32)::float8 AS rank
         FROM candidate_features f, q
         WHERE f.profile_tsv @@ q.q AND ($2::uuid[] IS NULL OR f.candidate_id = ANY($2::uuid[]))
         ORDER BY rank DESC, f.candidate_id LIMIT $3`,
        // Any term may match (OR): websearch_to_tsquery never fails on user-typed keywords.
        [query.split(/\s+/).filter(Boolean).join(' or '), o.candidateIds ?? null, o.k],
      );
      return rows.map((r) => ({ candidateId: r.candidate_id, bm25: Number(r.rank) }));
    });
  }

  async upsert(): Promise<void> {} // the read model is the index
  async remove(): Promise<void> {}
  async dropTenant(): Promise<void> {}
}

/** OpenSearch BM25 over the per-tenant index `t-{tenant}-profiles` (PRD §1.4). */
export class OpenSearchLexicalIndex implements LexicalIndex {
  constructor(
    private readonly baseUrl: string,
    private readonly doFetch: typeof fetch = fetch,
  ) {}

  private index(tenantId: string): string {
    return `${this.baseUrl.replace(/\/$/, '')}/t-${tenantId}-profiles`;
  }

  private async send(url: string, method: string, body?: unknown): Promise<Response> {
    try {
      const response = await this.doFetch(url, {
        method,
        headers: { 'Content-Type': 'application/json' },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        signal: AbortSignal.timeout(5000),
      });
      if (response.status >= 500 || response.status === 429)
        throw new UpstreamError(`opensearch: HTTP ${response.status}`);
      return response;
    } catch (error) {
      if (error instanceof UpstreamError) throw error;
      throw new UpstreamError(`opensearch: ${(error as Error).name}`);
    }
  }

  async search(
    tenantId: string,
    query: string,
    o: { k: number; candidateIds?: string[] },
  ): Promise<LexicalHit[]> {
    if (!query.trim()) return [];
    const response = await this.send(`${this.index(tenantId)}/_search`, 'POST', {
      size: o.k,
      _source: false,
      query: {
        bool: {
          must: { match: { profile_text: { query } } },
          ...(o.candidateIds ? { filter: { ids: { values: o.candidateIds } } } : {}),
        },
      },
    });
    if (response.status === 404) return []; // no profiles indexed yet for this tenant
    const body = (await response.json()) as { hits: { hits: { _id: string; _score: number }[] } };
    return body.hits.hits.map((h) => ({ candidateId: h._id, bm25: h._score }));
  }

  async upsert(f: CandidateFeatures): Promise<void> {
    await this.send(`${this.index(f.tenantId)}/_doc/${f.candidateId}`, 'PUT', {
      profile_text: f.profileText,
      current_title: f.currentTitle,
    });
  }

  async remove(tenantId: string, candidateId: string): Promise<void> {
    await this.send(`${this.index(tenantId)}/_doc/${candidateId}`, 'DELETE');
  }

  async dropTenant(tenantId: string): Promise<void> {
    await this.send(this.index(tenantId), 'DELETE');
  }
}
