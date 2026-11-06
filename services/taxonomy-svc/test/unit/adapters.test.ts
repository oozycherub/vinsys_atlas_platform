import { createServer, type Server } from 'node:http';
import { type AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ClientCredentialsTokenProvider, ConfigError } from '@atlas/platform';
import { loadTaxonomySvcConfig } from '../../src/config';
import { GatewayEmbeddingClient, HashingEmbeddingStub } from '../../src/infrastructure/embeddings';
import { parseCsv, toImportRows } from '../../src/infrastructure/spreadsheet-parser';

describe('CSV parsing', () => {
  it('handles quotes, embedded commas and newlines, CRLF and a BOM', () => {
    const text = '﻿path,name,aliases\r\na.b,"Kafka, Apache","say ""hi""\nthere"\r\n,,\r\nc.d,x,';
    expect(parseCsv(text)).toEqual([
      ['path', 'name', 'aliases'],
      ['a.b', 'Kafka, Apache', 'say "hi"\nthere'],
      ['', '', ''],
      ['c.d', 'x', ''],
    ]);
    expect(() => parseCsv('a,"b')).toThrow(/unterminated/);
  });

  it('maps headers case-insensitively, skips blank rows and keeps line numbers', () => {
    const rows = toImportRows([
      ['Path', 'NODE_TYPE', 'Name', 'ignored'],
      ['a.b.c.d', 'skill', 'X', 'zzz'],
      ['', '', '', ''],
      ['a.b.c.e', 'skill', 'Y', ''],
    ]);
    expect(rows).toEqual([
      { line: 2, values: { path: 'a.b.c.d', node_type: 'skill', name: 'X' } },
      { line: 4, values: { path: 'a.b.c.e', node_type: 'skill', name: 'Y' } },
    ]);
  });
});

describe('HashingEmbeddingStub', () => {
  it('is deterministic, unit length and lexical', async () => {
    const stub = new HashingEmbeddingStub();
    const [a, b, c] = await stub.embed(['Apache Kafka', 'apache kafka!', 'Spreadsheet modelling']);
    expect(a).toHaveLength(1024);
    expect(a).toEqual(b);
    const dot = (x: number[], y: number[]) => x.reduce((s, v, i) => s + v * y[i]!, 0);
    expect(dot(a!, a!)).toBeCloseTo(1, 6);
    expect(dot(a!, c!)).toBeLessThan(0.3);
  });
});

describe('gateway clients', () => {
  let server: Server;
  let base = '';
  const seen: { path: string; auth?: string | undefined; body: string }[] = [];

  beforeAll(async () => {
    server = createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += String(c)));
      req.on('end', () => {
        seen.push({ path: req.url ?? '', auth: req.headers['authorization'], body });
        res.setHeader('Content-Type', 'application/json');
        if (req.url === '/token') {
          res.end(JSON.stringify({ access_token: `tok-${seen.length}`, expires_in: 600 }));
          return;
        }
        const { input } = JSON.parse(body) as { input: string[] };
        const dims = input[0] === 'short' ? 3 : 1024;
        res.end(
          JSON.stringify({
            model: input[0] === 'stub-model' ? 'stub-hash-1024' : 'bge-m3',
            data: input
              .map((_, i) => ({ index: input.length - 1 - i, embedding: new Array(dims).fill(i) }))
              .reverse(),
          }),
        );
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(async () => {
    await new Promise<void>((r) => server.close(() => r()));
  });

  it('caches client-credentials tokens and embeds in input order', async () => {
    const tokens = new ClientCredentialsTokenProvider({
      tokenUrl: `${base}/token`,
      clientId: 'svc_taxonomy',
      clientSecret: 's3cret',
      scopes: ['embeddings:create'],
    });
    const [t1, t2] = await Promise.all([tokens.token(), tokens.token()]);
    expect(t1).toBe(t2);
    expect(seen.filter((s) => s.path === '/token')).toHaveLength(1);
    expect(seen[0]!.auth).toBe(`Basic ${Buffer.from('svc_taxonomy:s3cret').toString('base64')}`);
    expect(seen[0]!.body).toContain('scope=embeddings%3Acreate');

    const client = new GatewayEmbeddingClient({ baseUrl: base, token: () => tokens.token() });
    const vectors = await client.embed(['a', 'b']);
    expect(vectors.map((v) => v[0])).toEqual([1, 0]);
    expect(seen.at(-1)!.auth).toBe(`Bearer ${t1}`);
    expect(JSON.parse(seen.at(-1)!.body)).toMatchObject({
      model: 'bge-m3',
      purpose: 'taxonomy_normalisation',
    });
    await expect(client.embed(['short'])).rejects.toThrow(/1024 dimensions/);
    await expect(client.embed(['stub-model'])).rejects.toThrow(/from bge-m3, got stub-hash-1024/);
    await expect(client.embed(Array.from({ length: 65 }, () => 'x'))).rejects.toThrow(/64/);
    expect(await client.embed([])).toEqual([]);
  });
});

describe('taxonomy-svc config', () => {
  const base = {
    ATLAS_DATABASE_URL: 'postgres://atlas_app:pw@localhost:6432/atlas',
    ATLAS_AUTH_ISSUER: 'https://id.atlas.test',
    ATLAS_AUTH_AUDIENCE: 'atlas-api',
    ATLAS_AUTH_JWKS_URL: 'https://id.atlas.test/.well-known/jwks.json',
  };
  const problems = (env: Record<string, string>): string[] => {
    try {
      loadTaxonomySvcConfig(env);
      return [];
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigError);
      return (error as ConfigError).problems;
    }
  };

  it('defaults to the stub in development and refuses it in production', () => {
    expect(loadTaxonomySvcConfig(base)).toMatchObject({
      ATLAS_TAXONOMY_EMBEDDINGS: 'stub',
      ATLAS_TAXONOMY_PORT: 8083,
    });
    const prod = problems({ ...base, NODE_ENV: 'production' });
    expect(prod.some((p) => p.startsWith('ATLAS_TAXONOMY_EMBEDDINGS'))).toBe(true);
    expect(prod.some((p) => p.startsWith('ATLAS_TAXONOMY_EVENT_SOURCE'))).toBe(true);
  });

  it('requires everything the gateway adapter needs', () => {
    const found = problems({ ...base, ATLAS_TAXONOMY_EMBEDDINGS: 'gateway' });
    expect(found).toHaveLength(4);
    expect(
      problems({
        ...base,
        NODE_ENV: 'production',
        ATLAS_TAXONOMY_EMBEDDINGS: 'gateway',
        ATLAS_LLM_GATEWAY_URL: 'http://llm-gateway:8085',
        ATLAS_TAXONOMY_CLIENT_ID: 'svc_taxonomy',
        ATLAS_TAXONOMY_CLIENT_SECRET: 's',
        ATLAS_IDENTITY_TOKEN_URL: 'https://id.atlas.test/v1/oauth/token',
        ATLAS_TAXONOMY_EVENT_SOURCE: 'kafka',
        ATLAS_KAFKA_BROKERS: 'k1:9092',
      }),
    ).toEqual([]);
  });
});
