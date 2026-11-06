import { describe, expect, it } from 'vitest';
import { DEFAULT_WEIGHTS } from '@atlas/scoring';
import { UpstreamError } from '../../src/application/ports';
import { loadMatchingSvcConfig } from '../../src/config';
import { evidenceSnippets, profileText, yearsOf } from '../../src/domain/features';
import {
  applyPatch,
  embeddedText,
  isScorable,
  lexicalQuery,
  type Requisition,
  requirements,
} from '../../src/domain/requisition';
import { explain, scoreCandidate, toScored, weightsVersion } from '../../src/domain/score';
import { MemoryMatchCache } from '../../src/infrastructure/cache';
import {
  GatewayEmbedder,
  HttpTaxonomy,
  ParsingVectorSearch,
  TenantWeights,
} from '../../src/infrastructure/clients';
import { OpenSearchLexicalIndex } from '../../src/infrastructure/lexical';

const base: Requisition = {
  tenantId: 't',
  id: 'r',
  title: 'Data Engineer',
  description: 'Streaming pipelines',
  openings: 1,
  location: null,
  hiringManagerId: null,
  jobProfileId: null,
  minExperienceYears: 3,
  keywords: ['Kafka', 'c++'],
  status: 'open',
  calibrationStatus: 'calibrated',
  calibration: {
    source: 'manual',
    job_profile_version: null,
    skills: [
      {
        skill_id: 's1',
        name: 'Python',
        weight: 1,
        target: 4,
        must_have: true,
        related: [{ skill_id: 's2', rho: 0.5 }],
      },
    ],
    embedding_model: 'bge-m3',
    embedded_text: 'x',
    lexical_query: 'x',
  },
  calibrationVersion: 1,
  calibratedAt: new Date(),
  version: 2,
  createdBy: 'u',
  createdAt: new Date(),
  updatedAt: new Date(),
};

describe('domain', () => {
  it('weights_version is stable, order-sensitive and rejects bad weights', () => {
    expect(weightsVersion(DEFAULT_WEIGHTS)).toBe(
      weightsVersion({ lex: 0.1, exp: 0.15, cov: 0.35, sem: 0.4 }),
    );
    expect(weightsVersion(DEFAULT_WEIGHTS)).not.toBe(
      weightsVersion({ sem: 0.35, cov: 0.4, exp: 0.15, lex: 0.1 }),
    );
    expect(() => weightsVersion({ sem: 1, cov: 1, exp: 0, lex: 0 })).toThrow(/sum to 1/);
  });

  it('requisition patches make a calibration stale only when scoring inputs change', () => {
    expect(applyPatch(base, { openings: 3 }).calibrationStatus).toBe('calibrated');
    expect(applyPatch(base, { keywords: ['Kafka', 'c++'] }).calibrationStatus).toBe('calibrated');
    expect(applyPatch(base, { keywords: ['Spark'] }).calibrationStatus).toBe('stale');
    expect(
      applyPatch({ ...base, calibrationStatus: 'uncalibrated' }, { title: 'X' }).calibrationStatus,
    ).toBe('uncalibrated');
    expect(isScorable(base)).toBe(true);
    expect(isScorable({ ...base, status: 'closed' })).toBe(false);
    expect(isScorable({ ...base, calibration: null })).toBe(false);
    expect(requirements(base.calibration!)).toEqual([
      {
        skillId: 's1',
        weight: 1,
        target: 4,
        mustHave: true,
        related: [{ skillId: 's2', rho: 0.5 }],
      },
    ]);
  });

  it('builds the embedded text and the lexical query', () => {
    const skills = base.calibration!.skills;
    expect(embeddedText(base, skills)).toBe(
      'Data Engineer\nStreaming pipelines\nRequired skills: Python\nKeywords: Kafka, c++',
    );
    expect(lexicalQuery(base, skills)).toBe('data engineer kafka c++ python');
  });

  it('builds profile text and evidence snippets from the redacted profile', () => {
    const profile = {
      summary: 'Engineer.',
      work_history: [
        {
          title: 'Dev',
          employer: 'Acme',
          responsibilities: ['Built Kafka streams'],
          skills_mentioned: ['Kafka'],
        },
      ],
      education: [{ institution: 'Uni', degree: 'BSc' }],
      skills: [
        { raw: 'Kafka', skill_id: 'k' },
        { raw: 'Go', skill_id: 'g' },
        { raw: 'Unmapped', skill_id: null },
      ],
    };
    expect(profileText(profile)).toBe(
      'Engineer.\nDev Acme\nBuilt Kafka streams\nKafka\nUni\nBSc\nKafka\nGo\nUnmapped',
    );
    expect(evidenceSnippets(profile)).toEqual({
      k: 'Dev at Acme: Built Kafka streams',
      g: 'Listed skill: Go',
    });
    expect(yearsOf({ totalExperienceMonths: 30 })).toBe(2.5);
    expect(yearsOf({ totalExperienceMonths: null })).toBeNull();
  });

  it('explains scores with matched skills, gaps, related credit and evidence', () => {
    const result = scoreCandidate(
      {
        chunks: [],
        jobEmbedding: [1, 0],
        requirements: [
          ...requirements(base.calibration!),
          { skillId: 's3', weight: 1, target: 2, mustHave: false, related: [] },
          { skillId: 's4', weight: 1, target: 4, mustHave: false, related: [] },
        ],
        skills: new Map([
          ['s2', { proficiency: 4, validated: false }],
          ['s3', { proficiency: 5, validated: true }],
        ]),
        requiredYears: null,
        candidateYears: null,
        bm25: 0,
        maxBm25: 0,
      },
      DEFAULT_WEIGHTS,
    );
    const e = explain(result, { s2: 'Built things with s2', s3: 'Used s3' }, [
      'skills',
      'experience',
      'profile_summary',
      'projects',
    ]);
    expect(e.matched.map((m) => m.skill_id)).toEqual(['s3']);
    expect(e.partial).toEqual([
      {
        skill_id: 's1',
        required: 4,
        candidate: null,
        must_have: true,
        via: { skill_id: 's2', rho: 0.5 },
      },
    ]);
    expect(e.gaps.map((g) => g.skill_id)).toEqual(['s4']);
    expect(e.must_have_failed).toEqual([]); // 0.5 · 4 = 2 ≥ 2
    expect(e.evidence).toEqual([
      { skill_id: 's3', snippet: 'Used s3' },
      { skill_id: 's1', snippet: 'Built things with s2' },
    ]);
    expect(e.closest_chunks).toEqual(['skills', 'experience', 'profile_summary']);
    expect(toScored('c', result, {}, []).score).toBe(Math.round(result.score * 10_000) / 10_000);
  });
});

describe('adapters', () => {
  const token = async () => 'tok';

  function fakeFetch(
    handler: (url: string, init: RequestInit) => { status: number; body?: unknown },
  ) {
    const calls: { url: string; init: RequestInit }[] = [];
    const f = (async (url: string | URL | Request, init: RequestInit = {}) => {
      calls.push({ url: String(url), init });
      const r = handler(String(url), init);
      return new Response(r.body === undefined ? null : JSON.stringify(r.body), {
        status: r.status,
      });
    }) as typeof fetch;
    return { f, calls };
  }

  it('parsing vector search: model, ANN and per-candidate chunks with vectors', async () => {
    const { f, calls } = fakeFetch((url, init) => {
      if (url.endsWith('/v1/embedding-models'))
        return { status: 200, body: { active: 'bge-m3', shadow: null } };
      const body = JSON.parse(String(init.body)) as { per_candidate?: number };
      if (body.per_candidate) {
        return {
          status: 200,
          body: {
            results: [{ candidate_id: 'c', chunk_type: 'skills', score: 0.9, embedding: [1, 0] }],
          },
        };
      }
      return {
        status: 200,
        body: { results: [{ candidate_id: 'c', chunk_type: 'skills', score: 0.9 }] },
      };
    });
    const search = new ParsingVectorSearch({ baseUrl: 'http://parse/', token, fetch: f });
    expect(await search.activeModel()).toBe('bge-m3');
    expect(await search.activeModel()).toBe('bge-m3');
    expect(calls.filter((c) => c.url.endsWith('/v1/embedding-models'))).toHaveLength(1); // cached
    expect(await search.ann('t', [1, 0], 'bge-m3', 900)).toEqual([
      { candidateId: 'c', chunkType: 'skills', score: 0.9, vector: null },
    ]);
    expect(JSON.parse(String(calls.at(-1)!.init.body)).k).toBe(500);
    const chunks = await search.closestChunks('t', [1, 0], 'bge-m3', ['c'], 3);
    expect(chunks[0]!.vector).toEqual([1, 0]);
    expect(JSON.parse(String(calls.at(-1)!.init.body))).toMatchObject({
      candidate_ids: ['c'],
      per_candidate: 3,
      include_vectors: true,
    });
    expect(await search.closestChunks('t', [1], 'bge-m3', [], 3)).toEqual([]);
    expect((calls[0]!.init.headers as Record<string, string>)['Authorization']).toBe('Bearer tok');
  });

  it('maps outages and model changes to retryable errors', async () => {
    const down = new ParsingVectorSearch({
      baseUrl: 'http://p',
      token,
      fetch: fakeFetch(() => ({ status: 503 })).f,
    });
    await expect(down.activeModel()).rejects.toBeInstanceOf(UpstreamError);
    const moved = new ParsingVectorSearch({
      baseUrl: 'http://p',
      token,
      fetch: fakeFetch(() => ({ status: 409, body: {} })).f,
    });
    await expect(moved.ann('t', [1], 'old', 5)).rejects.toThrow(/model changed/);
    const broken = new ParsingVectorSearch({
      baseUrl: 'http://p',
      token,
      fetch: (async () => {
        throw new TypeError('fetch failed');
      }) as typeof fetch,
    });
    await expect(broken.activeModel()).rejects.toBeInstanceOf(UpstreamError);
    const rejected = new ParsingVectorSearch({
      baseUrl: 'http://p',
      token,
      fetch: fakeFetch(() => ({ status: 403, body: { code: 'FORBIDDEN' } })).f,
    });
    await expect(rejected.activeModel()).rejects.toThrow(/403 FORBIDDEN/);
  });

  it('gateway embeddings check the model', async () => {
    const ok = new GatewayEmbedder({
      baseUrl: 'http://gw',
      token,
      fetch: fakeFetch(() => ({
        status: 200,
        body: { model: 'bge-m3', data: [{ index: 0, embedding: [0.6, 0.8] }] },
      })).f,
    });
    expect(await ok.embed('t', 'text', 'bge-m3')).toEqual([0.6, 0.8]);
    await expect(ok.embed('t', 'text', 'other')).rejects.toThrow(/not other/);
    const empty = new GatewayEmbedder({
      baseUrl: 'http://gw',
      token,
      fetch: fakeFetch(() => ({ status: 200, body: { model: 'm', data: [] } })).f,
    });
    await expect(empty.embed('t', 'x', 'm')).rejects.toThrow(/missing/);
  });

  it('taxonomy: job profiles and RELATED_TO edges only', async () => {
    const { f } = fakeFetch((url) => {
      if (url.includes('/job-profiles/missing')) return { status: 404, body: {} };
      if (url.includes('/job-profiles/'))
        return { status: 200, body: { version: 3, title: 'T', skills: [], extra: 1 } };
      if (url.includes('/skills/missing')) return { status: 404, body: {} };
      return {
        status: 200,
        body: {
          name: 'Kafka',
          related: [
            { skill_id: 'p', edge_type: 'RELATED_TO', weight: 0.7 },
            { skill_id: 'q', edge_type: 'PREREQUISITE_OF', weight: 1 },
          ],
        },
      };
    });
    const t = new HttpTaxonomy({ baseUrl: 'http://tax', token, fetch: f });
    expect(await t.jobProfile('t', 'jp')).toEqual({ version: 3, title: 'T', skills: [] });
    expect(await t.jobProfile('t', 'missing')).toBeNull();
    expect(await t.skill('t', 's')).toEqual({
      name: 'Kafka',
      related: [{ skill_id: 'p', rho: 0.7 }],
    });
    expect(await t.skill('t', 'missing')).toBeNull();
  });

  it('tenant weights are asserted, cached and evictable', async () => {
    let weights = DEFAULT_WEIGHTS;
    const { f, calls } = fakeFetch(() => ({
      status: 200,
      body: { settings: { matching: { weights } } },
    }));
    const source = new TenantWeights({ baseUrl: 'http://tenant', token, fetch: f });
    expect(await source.weights('t')).toEqual(DEFAULT_WEIGHTS);
    await source.weights('t');
    expect(calls).toHaveLength(1);
    weights = { sem: 1, cov: 1, exp: 0, lex: 0 };
    source.evict('t');
    await expect(source.weights('t')).rejects.toThrow(/sum to 1/);
  });

  it('OpenSearch BM25 adapter: per-tenant index, id filter, CDC', async () => {
    const { f, calls } = fakeFetch((url, init) => {
      if (url.includes('/_search')) {
        return url.includes('t-empty-')
          ? { status: 404, body: {} }
          : { status: 200, body: { hits: { hits: [{ _id: 'c1', _score: 7.5 }] } } };
      }
      return { status: init.method === 'DELETE' ? 200 : 201, body: {} };
    });
    const os = new OpenSearchLexicalIndex('http://os:9200/', f);
    expect(await os.search('tid', 'kafka spark', { k: 10, candidateIds: ['c1'] })).toEqual([
      { candidateId: 'c1', bm25: 7.5 },
    ]);
    expect(calls[0]!.url).toBe('http://os:9200/t-tid-profiles/_search');
    expect(JSON.parse(String(calls[0]!.init.body)).query.bool.filter).toEqual({
      ids: { values: ['c1'] },
    });
    expect(await os.search('empty', 'x', { k: 1 })).toEqual([]);
    expect(await os.search('tid', '  ', { k: 1 })).toEqual([]);
    await os.upsert({
      tenantId: 'tid',
      candidateId: 'c1',
      skills: [],
      evidence: {},
      totalExperienceMonths: null,
      currentTitle: 'Dev',
      profileText: 'text',
    });
    expect(calls.at(-1)).toMatchObject({
      url: 'http://os:9200/t-tid-profiles/_doc/c1',
      init: { method: 'PUT' },
    });
    await os.remove('tid', 'c1');
    await os.dropTenant('tid');
    expect(calls.at(-1)).toMatchObject({
      url: 'http://os:9200/t-tid-profiles',
      init: { method: 'DELETE' },
    });
    const down = new OpenSearchLexicalIndex('http://os', fakeFetch(() => ({ status: 503 })).f);
    await expect(down.search('t', 'x', { k: 1 })).rejects.toBeInstanceOf(UpstreamError);
  });

  it('match cache expires and evicts by prefix', () => {
    let now = 0;
    const cache = new MemoryMatchCache(() => now, 2);
    cache.set('t1:r1:1:w', 'a', 10);
    cache.set('t1:r2:1:w', 'b', 10);
    expect(cache.get('t1:r1:1:w')).toBe('a');
    cache.set('t2:r1:1:w', 'c', 10); // over capacity: the oldest entry goes
    expect(cache.get('t1:r1:1:w')).toBeUndefined();
    cache.evictPrefix('t1:');
    expect(cache.get('t1:r2:1:w')).toBeUndefined();
    now = 10_001;
    expect(cache.get('t2:r1:1:w')).toBeUndefined();
  });
});

describe('config', () => {
  const env = {
    ATLAS_DATABASE_URL: 'postgres://atlas_app:pw@localhost:6432/atlas',
    ATLAS_AUTH_ISSUER: 'https://id.atlas.test',
    ATLAS_AUTH_AUDIENCE: 'atlas-api',
    ATLAS_AUTH_JWKS_URL: 'https://id.atlas.test/.well-known/jwks.json',
    ATLAS_IDENTITY_TOKEN_URL: 'https://id.atlas.test/token',
    ATLAS_MATCHING_CLIENT_ID: 'svc_matching',
    ATLAS_MATCHING_CLIENT_SECRET: 's',
    ATLAS_TENANT_SVC_URL: 'http://tenant',
    ATLAS_TAXONOMY_SVC_URL: 'http://tax',
    ATLAS_PARSING_SVC_URL: 'http://parse',
    ATLAS_LLM_GATEWAY_URL: 'http://gw',
  };

  it('defaults to Postgres BM25 and refuses unsafe production settings', () => {
    expect(loadMatchingSvcConfig(env)).toMatchObject({
      ATLAS_MATCHING_LEXICAL: 'postgres',
      ATLAS_MATCHING_PORT: 8087,
    });
    expect(() => loadMatchingSvcConfig({ ...env, ATLAS_MATCHING_LEXICAL: 'opensearch' })).toThrow(
      /ATLAS_OPENSEARCH_URL/,
    );
    expect(() => loadMatchingSvcConfig({ ...env, NODE_ENV: 'production' })).toThrow(
      /ATLAS_MATCHING_EVENT_SOURCE/,
    );
    expect(() => loadMatchingSvcConfig({ ...env, ATLAS_MATCHING_EVENT_SOURCE: 'kafka' })).toThrow(
      /ATLAS_KAFKA_BROKERS/,
    );
  });
});
