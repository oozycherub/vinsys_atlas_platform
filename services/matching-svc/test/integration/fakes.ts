/** Test doubles for matching-svc's network dependencies (parsing-svc, llm-gateway, taxonomy, tenant-svc). */
import { createHash } from 'node:crypto';
import { DEFAULT_WEIGHTS, normalise, cosine, type Weights } from '@atlas/scoring';
import {
  type ChunkHit,
  type Embedder,
  type JobProfileSnapshot,
  type SkillSnapshot,
  type Taxonomy,
  UpstreamError,
  type VectorSearch,
  type WeightsSource,
} from '../../src/application/ports';

/** Hashed bag-of-words, 1024-d, normalised: similar text → similar vectors, deterministically. */
export function embedText(text: string): number[] {
  const v = new Array<number>(1024).fill(0);
  for (const word of text.toLowerCase().match(/[\p{L}\p{N}+#]+/gu) ?? []) {
    const h = createHash('sha256').update(word).digest();
    const i = h.readUInt32BE(0) % 1024;
    v[i] = (v[i] ?? 0) + 1;
  }
  return v.some((x) => x !== 0) ? normalise(v) : [1, ...new Array<number>(1023).fill(0)];
}

interface StoredChunk {
  candidateId: string;
  chunkType: string;
  vector: number[];
}

/** parsing-svc's resume_embeddings, partitioned by tenant exactly as RLS partitions it there. */
export class FakeVectorSearch implements VectorSearch {
  readonly byTenant = new Map<string, StoredChunk[]>();
  readonly calls: { kind: string; tenantId: string }[] = [];
  model = 'bge-m3';
  down = false;

  addCandidate(tenantId: string, candidateId: string, chunks: Record<string, string>): void {
    const list = (this.byTenant.get(tenantId) ?? []).filter((c) => c.candidateId !== candidateId);
    for (const [chunkType, text] of Object.entries(chunks)) {
      list.push({ candidateId, chunkType, vector: embedText(text) });
    }
    this.byTenant.set(tenantId, list);
  }

  async activeModel(): Promise<string> {
    if (this.down) throw new UpstreamError('parsing-svc down');
    return this.model;
  }

  async ann(tenantId: string, vector: number[], model: string, k: number): Promise<ChunkHit[]> {
    this.calls.push({ kind: 'ann', tenantId });
    if (this.down) throw new UpstreamError('parsing-svc down');
    if (model !== this.model) throw new UpstreamError('model mismatch');
    return (this.byTenant.get(tenantId) ?? [])
      .map((c) => ({
        candidateId: c.candidateId,
        chunkType: c.chunkType,
        score: cosine(c.vector, vector),
        vector: null,
      }))
      .sort((a, b) => b.score - a.score)
      .slice(0, k);
  }

  async closestChunks(
    tenantId: string,
    vector: number[],
    model: string,
    candidateIds: string[],
    perCandidate: number,
  ): Promise<ChunkHit[]> {
    this.calls.push({ kind: 'chunks', tenantId });
    if (model !== this.model) throw new UpstreamError('model mismatch');
    const wanted = new Set(candidateIds);
    const out: ChunkHit[] = [];
    for (const id of wanted) {
      out.push(
        ...(this.byTenant.get(tenantId) ?? [])
          .filter((c) => c.candidateId === id)
          .map((c) => ({
            candidateId: id,
            chunkType: c.chunkType,
            score: cosine(c.vector, vector),
            vector: c.vector,
          }))
          .sort((a, b) => b.score - a.score)
          .slice(0, perCandidate),
      );
    }
    return out;
  }
}

export class FakeEmbedder implements Embedder {
  readonly texts: string[] = [];

  async embed(_tenantId: string, text: string): Promise<number[]> {
    this.texts.push(text);
    return embedText(text);
  }
}

export class FakeTaxonomy implements Taxonomy {
  readonly profiles = new Map<string, JobProfileSnapshot>();
  readonly skills = new Map<string, SkillSnapshot>();

  async jobProfile(_tenantId: string, id: string): Promise<JobProfileSnapshot | null> {
    return this.profiles.get(id) ?? null;
  }

  async skill(_tenantId: string, id: string): Promise<SkillSnapshot | null> {
    return this.skills.get(id) ?? null;
  }
}

export class FakeWeights implements WeightsSource {
  readonly weightsByTenant = new Map<string, Weights>();
  readonly evicted: string[] = [];

  async weights(tenantId: string): Promise<Weights> {
    const w = this.weightsByTenant.get(tenantId) ?? DEFAULT_WEIGHTS;
    // Mirrors TenantWeights: what tenant-svc returns is asserted before use.
    const { assertWeights } = await import('@atlas/scoring');
    return assertWeights(w);
  }

  evict(tenantId: string): void {
    this.evicted.push(tenantId);
  }
}
