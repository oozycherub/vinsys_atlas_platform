import { assertWeights, type Weights } from '@atlas/scoring';
import {
  type ChunkHit,
  type Embedder,
  type JobProfileSnapshot,
  type SkillSnapshot,
  type Taxonomy,
  UpstreamError,
  type VectorSearch,
  type WeightsSource,
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
  if (response.status === 429 || response.status >= 500) {
    throw new UpstreamError(`${path}: HTTP ${response.status}`);
  }
  return response;
}

async function json<T>(response: Response, what: string): Promise<T> {
  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as { code?: string };
    throw new UpstreamError(`${what}: HTTP ${response.status} ${body.code ?? ''}`.trim());
  }
  return (await response.json()) as T;
}

interface SearchResult {
  candidate_id: string;
  chunk_type: string;
  score: number;
  embedding?: number[];
}

/** parsing-svc `POST /v1/resume-embeddings:search` (scope embeddings:search). */
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

  async ann(tenantId: string, vector: number[], model: string, k: number): Promise<ChunkHit[]> {
    return this.search({ tenant_id: tenantId, vector, model_id: model, k: Math.min(k, 500) });
  }

  async closestChunks(
    tenantId: string,
    vector: number[],
    model: string,
    candidateIds: string[],
    perCandidate: number,
  ): Promise<ChunkHit[]> {
    if (candidateIds.length === 0) return [];
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
      this.model = null; // the active model changed under us; the next call refetches it
      throw new UpstreamError('embedding model changed; retry');
    }
    const result = await json<{ results: SearchResult[] }>(response, 'vector search');
    return result.results.map((r) => ({
      candidateId: r.candidate_id,
      chunkType: r.chunk_type,
      score: r.score,
      vector: r.embedding ?? null,
    }));
  }
}

/** llm-gateway `POST /v1/embeddings` (scope embeddings:create); the response model is checked. */
export class GatewayEmbedder implements Embedder {
  constructor(private readonly o: HttpOptions) {}

  async embed(tenantId: string, text: string, model: string): Promise<number[]> {
    const body = await json<{ model: string; data: { index: number; embedding: number[] }[] }>(
      await call(this.o, '/v1/embeddings', {
        method: 'POST',
        body: { model, input: [text], purpose: 'requisition_matching', tenant_id: tenantId },
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

/** taxonomy-svc: job profiles and skill details (RELATED_TO edges give ρ). */
export class HttpTaxonomy implements Taxonomy {
  constructor(private readonly o: HttpOptions) {}

  async jobProfile(tenantId: string, id: string): Promise<JobProfileSnapshot | null> {
    const response = await call(this.o, `/v1/job-profiles/${id}?tenant_id=${tenantId}`);
    if (response.status === 404) return null;
    const p = await json<JobProfileSnapshot>(response, 'job profile');
    return { version: p.version, title: p.title, skills: p.skills };
  }

  async skill(tenantId: string, id: string): Promise<SkillSnapshot | null> {
    const response = await call(this.o, `/v1/skills/${id}?tenant_id=${tenantId}`);
    if (response.status === 404) return null;
    const s = await json<{
      name: string;
      related: { skill_id: string; edge_type: string; weight: number }[];
    }>(response, 'skill');
    return {
      name: s.name,
      related: s.related
        .filter((r) => r.edge_type === 'RELATED_TO')
        .map((r) => ({ skill_id: r.skill_id, rho: r.weight })),
    };
  }
}

/** Tenant matching weights from tenant-svc (scope tenant-settings:read), cached per tenant. */
export class TenantWeights implements WeightsSource {
  private readonly cache = new Map<string, { weights: Weights; at: number }>();

  constructor(
    private readonly o: HttpOptions,
    private readonly ttlMs = 300_000,
  ) {}

  async weights(tenantId: string): Promise<Weights> {
    const hit = this.cache.get(tenantId);
    if (hit && Date.now() - hit.at < this.ttlMs) return hit.weights;
    const body = await json<{ settings: { matching: { weights: Weights } } }>(
      await call(this.o, `/v1/tenants/${tenantId}/settings`),
      'tenant settings',
    );
    const weights = assertWeights(body.settings.matching.weights);
    this.cache.set(tenantId, { weights, at: Date.now() });
    return weights;
  }

  evict(tenantId: string): void {
    this.cache.delete(tenantId);
  }
}
