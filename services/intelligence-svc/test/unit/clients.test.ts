/** The HTTP clients against a fake fetch (parsing-svc, llm-gateway, taxonomy-svc). */
import { describe, expect, it } from 'vitest';
import { UpstreamError } from '../../src/application/ports';
import {
  GatewayEmbedder,
  HttpTaxonomy,
  ParsingVectorSearch,
} from '../../src/infrastructure/clients';

type Handler = (url: string, init: RequestInit) => Response | Promise<Response>;

function client(handler: Handler) {
  const calls: { url: string; body: unknown }[] = [];
  const fetchFn = (async (url: string | URL, init?: RequestInit) => {
    calls.push({ url: String(url), body: init?.body ? JSON.parse(String(init.body)) : null });
    return handler(String(url), init ?? {});
  }) as typeof fetch;
  return {
    calls,
    options: { baseUrl: 'http://svc/', token: () => Promise.resolve('t'), fetch: fetchFn },
  };
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

describe('ParsingVectorSearch', () => {
  it('caches the active model and searches chunks', async () => {
    const { calls, options } = client((url) =>
      url.endsWith('/v1/embedding-models')
        ? json(200, { active: 'bge-m3' })
        : json(200, {
            results: [
              { candidate_id: 'c1', score: 0.9, embedding: [1, 0] },
              { candidate_id: 'c2', score: 0.5 },
            ],
          }),
    );
    const v = new ParsingVectorSearch(options);
    expect(await v.activeModel()).toBe('bge-m3');
    expect(await v.activeModel()).toBe('bge-m3');
    expect(calls.filter((c) => c.url.endsWith('/v1/embedding-models'))).toHaveLength(1);
    expect(await v.closestChunks('t1', [1, 0], 'bge-m3', ['c1', 'c2'], 3)).toEqual([
      { candidateId: 'c1', similarity: 0.9, vector: [1, 0] },
      { candidateId: 'c2', similarity: 0.5, vector: null },
    ]);
    expect(calls.at(-1)?.body).toMatchObject({
      candidate_ids: ['c1', 'c2'],
      per_candidate: 3,
      include_vectors: true,
      k: 6,
    });
    expect(await v.closestChunks('t1', [1], 'bge-m3', [], 3)).toEqual([]);
    await v.ann('t1', [1, 0], 'bge-m3', 5000);
    expect(calls.at(-1)?.body).toMatchObject({ k: 500 });
  });

  it('surfaces failures as UpstreamError', async () => {
    const changed = new ParsingVectorSearch(client(() => json(409, {})).options, 0);
    await expect(changed.ann('t', [1], 'm', 1)).rejects.toThrow('model changed');
    await expect(
      new ParsingVectorSearch(client(() => json(503, {})).options).activeModel(),
    ).rejects.toBeInstanceOf(UpstreamError);
    await expect(
      new ParsingVectorSearch(client(() => json(400, { code: 'BAD' })).options).ann(
        't',
        [1],
        'm',
        1,
      ),
    ).rejects.toThrow('BAD');
    await expect(
      new ParsingVectorSearch(client(() => json(400, 'x')).options).ann('t', [1], 'm', 1),
    ).rejects.toThrow('HTTP 400');
    const down = client(() => {
      throw new TypeError('fetch failed');
    });
    await expect(new ParsingVectorSearch(down.options).activeModel()).rejects.toThrow('TypeError');
  });
});

describe('GatewayEmbedder', () => {
  it('embeds and checks the model', async () => {
    const ok = client(() =>
      json(200, { model: 'bge-m3', data: [{ index: 0, embedding: [0.6, 0.8] }] }),
    );
    expect(await new GatewayEmbedder(ok.options).embed('t1', 'text', 'bge-m3')).toEqual([0.6, 0.8]);
    expect(ok.calls[0]?.body).toMatchObject({
      purpose: 'marketplace_matching',
      input: ['text'],
      tenant_id: 't1',
    });
    await expect(
      new GatewayEmbedder(client(() => json(200, { model: 'other', data: [] })).options).embed(
        't',
        'x',
        'bge-m3',
      ),
    ).rejects.toThrow('came from other');
    await expect(
      new GatewayEmbedder(client(() => json(200, { model: 'bge-m3', data: [] })).options).embed(
        't',
        'x',
        'bge-m3',
      ),
    ).rejects.toThrow('missing');
  });
});

describe('HttpTaxonomy', () => {
  it('reads RELATED_TO edges only', async () => {
    const t = new HttpTaxonomy(
      client((url) =>
        url.includes('/missing')
          ? json(404, {})
          : json(200, {
              related: [
                { skill_id: 's2', edge_type: 'RELATED_TO', weight: 0.6 },
                { skill_id: 's3', edge_type: 'PREREQUISITE_OF', weight: 0.9 },
              ],
            }),
      ).options,
    );
    expect(await t.related('t1', 's1')).toEqual([{ skillId: 's2', rho: 0.6 }]);
    expect(await t.related('t1', 'missing')).toEqual([]);
  });
});
