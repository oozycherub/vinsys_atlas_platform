/** Test doubles for intelligence-svc's network dependencies (parsing-svc, llm-gateway, taxonomy). */
import { createHash } from 'node:crypto';
import { cosine, normalise } from '@atlas/scoring';
import {
  type ChunkHit,
  type Embedder,
  type Taxonomy,
  UpstreamError,
  type VectorSearch,
} from '../../src/application/ports';

/** Hashed bag-of-words, 64-d, normalised: similar text gives similar vectors, deterministically. */
export function embedText(text: string): number[] {
  const v = new Array<number>(64).fill(0);
  for (const word of text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []) {
    const i = createHash('sha256').update(word).digest().readUInt32BE(0) % 64;
    v[i] = (v[i] ?? 0) + 1;
  }
  return v.some((x) => x !== 0) ? normalise(v) : [1, ...new Array<number>(63).fill(0)];
}

export class FakeVectorSearch implements VectorSearch {
  readonly byTenant = new Map<string, { candidateId: string; vector: number[] }[]>();
  readonly calls: string[] = [];
  down = false;

  add(tenantId: string, candidateId: string, text: string): void {
    this.byTenant.set(tenantId, [
      ...(this.byTenant.get(tenantId) ?? []),
      { candidateId, vector: embedText(text) },
    ]);
  }

  activeModel(): Promise<string> {
    return this.down
      ? Promise.reject(new UpstreamError('parsing-svc down'))
      : Promise.resolve('bge-m3');
  }

  ann(tenantId: string, vector: number[], _model: string, k: number): Promise<ChunkHit[]> {
    this.calls.push(`ann:${tenantId}`);
    return Promise.resolve(
      (this.byTenant.get(tenantId) ?? [])
        .map((c) => ({
          candidateId: c.candidateId,
          vector: c.vector,
          similarity: cosine(c.vector, vector),
        }))
        .sort((a, b) => b.similarity - a.similarity)
        .slice(0, k),
    );
  }

  closestChunks(
    tenantId: string,
    vector: number[],
    _model: string,
    ids: string[],
  ): Promise<ChunkHit[]> {
    this.calls.push(`chunks:${tenantId}`);
    if (this.down) return Promise.reject(new UpstreamError('parsing-svc down'));
    return Promise.resolve(
      (this.byTenant.get(tenantId) ?? [])
        .filter((c) => ids.includes(c.candidateId))
        .map((c) => ({
          candidateId: c.candidateId,
          vector: c.vector,
          similarity: cosine(c.vector, vector),
        })),
    );
  }
}

export class FakeEmbedder implements Embedder {
  calls = 0;
  embed(_tenantId: string, text: string): Promise<number[]> {
    this.calls += 1;
    return Promise.resolve(embedText(text));
  }
}

export class FakeTaxonomy implements Taxonomy {
  readonly related_ = new Map<string, { skillId: string; rho: number }[]>();
  fail = false;
  related(_tenantId: string, skillId: string): Promise<{ skillId: string; rho: number }[]> {
    if (this.fail) return Promise.reject(new UpstreamError('taxonomy down'));
    return Promise.resolve(this.related_.get(skillId) ?? []);
  }
}
