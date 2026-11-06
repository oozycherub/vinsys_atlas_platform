import {
  type ChunkHit,
  type Embedder,
  type Taxonomy,
  UpstreamError,
  type VectorSearch,
} from '../application/ports';

export interface HttpOptions {
  baseUrl: string;
  token: () => Promise<string>;
  timeoutMs?: number;
  fetch?: typeof fetch;
}

async function call(
  o: HttpOptions,
  path: string,
  init: { method?: string; body?: unknown } = {},
): Promise<Response> {
  const doFetch = o.fetch ?? fetch;
  let response: Response;
  try {
    response = await doFetch(`${o.baseUrl.replace(/\/$/, '')}${path}`, {
      method: init.method ?? 'GET',
      headers: {
        Authorization: `Bearer ${await o.token()}`,
        ...(init.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
      signal: AbortSignal.timeout(o.timeoutMs ?? 5000),
    });
  } catch (error) {
    throw new UpstreamError(`${path}: ${(error as Error).name}`);
  }
  if (response.status === 429 || response.status >= 500)
    throw new UpstreamError(`${path}: HTTP ${response.status}`);
  return response;
}

async function json<T>(response: Response, what: string): Promise<T> {
  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as { code?: string };
    throw new UpstreamError(`${what}: HTTP ${response.status} ${body.code ?? ''}`.trim());
  }
  return (await response.json()) as T;
}

/** parsing-svc's profile-chunk index (`POST /v1/resume-embeddings:search`, scope embeddings:search). */
export class ParsingVectorSearch implements VectorSearch {
  private model: { id: string; at: number } | null = null;

  constructor(
    private readonly o: HttpOptions,
    private readonly modelTtlMs = 60_000,
  ) {}

  async activeModel(): Promise<string> {
    if (this.model && Date.now() - this.model.at < this.modelTtlMs) return this.model.id;
    const body = await json<{ active: string }>(
      await call(this.o, '/v1/embedding-models'),
      'embedding models',
    );
    this.model = { id: body.active, at: Date.now() };
    return body.active;
  }

  ann(tenantId: string, vector: number[], model: string, k: number): Promise<ChunkHit[]> {
    return this.search({ tenant_id: tenantId, vector, model_id: model, k: Math.min(k, 500) });
  }

  closestChunks(
    tenantId: string,
    vector: number[],
    model: string,
    candidateIds: string[],
    perCandidate: number,
  ): Promise<ChunkHit[]> {
    if (candidateIds.length === 0) return Promise.resolve([]);
    return this.search({
      tenant_id: tenantId,
      vector,
      model_id: model,
      candidate_ids: candidateIds,
      per_candidate: perCandidate,
      include_vectors: true,
      k: Math.min(3000, candidateIds.length * perCandidate),
    });
  }

  private async search(body: Record<string, unknown>): Promise<ChunkHit[]> {
    const response = await call(this.o, '/v1/resume-embeddings:search', { method: 'POST', body });
    if (response.status === 409) {
      this.model = null;
      throw new UpstreamError('embedding model changed; retry');
    }
    const result = await json<{
      results: { candidate_id: string; score: number; embedding?: number[] }[];
    }>(response, 'vector search');
    return result.results.map((r) => ({
      candidateId: r.candidate_id,
      similarity: r.score,
      vector: r.embedding ?? null,
    }));
  }
}

/** llm-gateway `POST /v1/embeddings` (scope embeddings:create). */
export class GatewayEmbedder implements Embedder {
  constructor(private readonly o: HttpOptions) {}

  async embed(tenantId: string, text: string, model: string): Promise<number[]> {
    const body = await json<{ model: string; data: { index: number; embedding: number[] }[] }>(
      await call(this.o, '/v1/embeddings', {
        method: 'POST',
        body: { model, input: [text], purpose: 'marketplace_matching', tenant_id: tenantId },
      }),
      'embeddings',
    );
    if (body.model !== model)
      throw new UpstreamError(`embeddings came from ${body.model}, not ${model}`);
    const vector = body.data.find((d) => d.index === 0)?.embedding;
    if (!vector) throw new UpstreamError('embedding missing from the response');
    return vector;
  }
}

/** taxonomy-svc skill details: RELATED_TO edges give ρ for related-skill credit. */
export class HttpTaxonomy implements Taxonomy {
  constructor(private readonly o: HttpOptions) {}

  async related(tenantId: string, skillId: string): Promise<{ skillId: string; rho: number }[]> {
    const response = await call(this.o, `/v1/skills/${skillId}?tenant_id=${tenantId}`);
    if (response.status === 404) return [];
    const s = await json<{ related: { skill_id: string; edge_type: string; weight: number }[] }>(
      response,
      'skill',
    );
    return s.related
      .filter((r) => r.edge_type === 'RELATED_TO')
      .map((r) => ({ skillId: r.skill_id, rho: r.weight }));
  }
}
