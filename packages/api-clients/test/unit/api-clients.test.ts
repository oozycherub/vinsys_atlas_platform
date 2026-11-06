import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createAtlasClients, isProblem } from '../../src/index';

describe('generated clients', () => {
  it('are up to date with every openapi.yaml', () => {
    const out = execFileSync(
      'node',
      [path.resolve(__dirname, '../../scripts/generate.mjs'), '--check'],
      { encoding: 'utf8' },
    );
    expect(out).toContain('clients up to date');
  }, 60_000);

  it('call the gateway with the bearer token and report problems', async () => {
    const seen: Request[] = [];
    const problems: unknown[] = [];
    const fake = ((input: Request) => {
      seen.push(input);
      if (input.url.endsWith('/v1/reports/r1'))
        return Promise.resolve(
          new Response(
            JSON.stringify({
              type: 'about:blank',
              title: 'Not found',
              status: 404,
              code: 'REPORT_NOT_FOUND',
            }),
            {
              status: 404,
              headers: { 'content-type': 'application/problem+json', 'x-request-id': 'req-1' },
            },
          ),
        );
      return Promise.resolve(
        new Response(JSON.stringify({ items: [] }), {
          headers: { 'content-type': 'application/json' },
        }),
      );
    }) as unknown as typeof fetch;
    const api = createAtlasClients({
      baseUrl: 'https://acme.atlas.test/',
      token: () => 'tok',
      fetch: fake,
      onProblem: (status, code, requestId) => problems.push({ status, code, requestId }),
    });
    const ok = await api.notification.GET('/v1/me/notifications', {
      params: { query: { limit: 5 } },
    });
    expect(ok.response.status).toBe(200);
    expect(seen[0]?.url).toBe('https://acme.atlas.test/v1/me/notifications?limit=5');
    expect(seen[0]?.headers.get('authorization')).toBe('Bearer tok');
    const missing = await api.report.GET('/v1/reports/{id}', { params: { path: { id: 'r1' } } });
    expect(isProblem(missing.error)).toBe(true);
    expect(problems).toEqual([{ status: 404, code: 'REPORT_NOT_FOUND', requestId: 'req-1' }]);
    expect(isProblem('x')).toBe(false);
    const anonymous = createAtlasClients({ baseUrl: 'https://acme.atlas.test', fetch: fake });
    await anonymous.identity.POST('/v1/auth/magic-links', {
      body: { tenant_slug: 'acme', email: 'a@b.test' },
    });
    expect(seen[2]?.headers.get('authorization')).toBeNull();
  });
});
