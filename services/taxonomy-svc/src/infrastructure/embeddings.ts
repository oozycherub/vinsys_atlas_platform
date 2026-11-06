import { EMBEDDING_DIMENSIONS, type EmbeddingPort } from '../application/ports';
import { termKey } from '../domain/terms';

function fnv1a(text: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

/**
 * Development/test stand-in for bge-m3 (docs/prompts/03-taxonomy-svc.md §2 "Out"): hashed
 * bag of words and character trigrams, L2-normalised, 1024 dimensions. Deterministic and
 * LEXICAL ONLY: "JS" and "JavaScript" are not close. Semantic matching needs the gateway.
 */
export class HashingEmbeddingStub implements EmbeddingPort {
  readonly model = 'atlas-hash-v1';

  embed(texts: readonly string[]): Promise<number[][]> {
    return Promise.resolve(texts.map((t) => this.vector(t)));
  }

  private vector(text: string): number[] {
    const v = new Array<number>(EMBEDDING_DIMENSIONS).fill(0);
    const add = (feature: string, weight: number): void => {
      const h = fnv1a(feature);
      const i = h % EMBEDDING_DIMENSIONS;
      v[i] = (v[i] ?? 0) + (h >>> 31 === 1 ? -weight : weight);
    };
    for (const token of termKey(text).split(' ').filter(Boolean)) {
      add(`w:${token}`, 1);
      const padded = `^${token}$`;
      for (let i = 0; i + 3 <= padded.length; i += 1) add(`t:${padded.slice(i, i + 3)}`, 0.5);
    }
    const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1;
    return v.map((x) => x / norm);
  }
}

export interface GatewayEmbeddingOptions {
  /** llm-gateway base URL. */
  baseUrl: string;
  token: () => Promise<string>;
  model?: string;
  timeoutMs?: number;
}

/**
 * llm-gateway embeddings (docs/prompts/05-llm-gateway.md: POST /v1/embeddings, batch ≤ 64).
 * Request `{model, input[], purpose}`; response `{model, data: [{index, embedding}]}`.
 */
export class GatewayEmbeddingClient implements EmbeddingPort {
  readonly model: string;

  constructor(private readonly options: GatewayEmbeddingOptions) {
    this.model = options.model ?? 'bge-m3';
  }

  async embed(texts: readonly string[]): Promise<number[][]> {
    if (texts.length === 0) return [];
    if (texts.length > 64) throw new Error('The gateway accepts at most 64 inputs per call.');
    const response = await fetch(`${this.options.baseUrl.replace(/\/$/, '')}/v1/embeddings`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${await this.options.token()}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ model: this.model, input: texts, purpose: 'taxonomy_normalisation' }),
      signal: AbortSignal.timeout(this.options.timeoutMs ?? 5000),
    });
    if (!response.ok) throw new Error(`Embedding request failed with HTTP ${response.status}.`);
    const body = (await response.json()) as {
      model?: string;
      data?: { index: number; embedding: number[] }[];
    };
    // Vectors from another model live in a different space: storing them would silently corrupt
    // nearest-neighbour search (e.g. a development stub answering in place of bge-m3).
    if (body.model !== this.model) {
      throw new Error(`Expected embeddings from ${this.model}, got ${body.model ?? 'no model'}.`);
    }
    const out = new Array<number[] | undefined>(texts.length).fill(undefined);
    for (const item of body.data ?? []) {
      if (item.embedding.length !== EMBEDDING_DIMENSIONS) {
        throw new Error(
          `Expected ${EMBEDDING_DIMENSIONS} dimensions, got ${item.embedding.length}.`,
        );
      }
      out[item.index] = item.embedding;
    }
    if (out.some((v) => v === undefined)) throw new Error('Missing embeddings in the response.');
    return out as number[][];
  }
}
