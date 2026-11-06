import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { FixedClock } from '@atlas/platform';
import { loadGatewayConfig } from '../../src/config';
import { hostTarget } from '../../src/host';
import { escapeHtml, page } from '../../src/pages';
import {
  type DirectoryEntry,
  HttpDirectorySource,
  NEGATIVE_TTL_MS,
  POSITIVE_TTL_MS,
  TenantResolver,
} from '../../src/resolver';
import { loadRouteMap, parseRouteMap, patternMatches } from '../../src/route-map';

const ROOT = path.resolve(__dirname, '../../../..');
const routes = loadRouteMap(path.join(ROOT, 'infra/gateway/routes.yaml'));

/** Services reachable from outside (the rest are cell-internal). */
const PUBLIC_SERVICES = [
  'tenant-svc',
  'identity-svc',
  'taxonomy-svc',
  'profile-svc',
  'matching-svc',
  'assessment-svc',
  'proctoring-svc',
  'interview-svc',
  'intelligence-svc',
  'notification-svc',
  'report-svc',
];

function openapiPaths(service: string): string[] {
  const text = readFileSync(path.join(ROOT, 'services', service, 'openapi.yaml'), 'utf8');
  return [...text.matchAll(/^ {2}(\/[^\s:]*(?::[A-Za-z]+)?):\s*$/gm)].map((m) =>
    (m[1] as string).replace(/\{[^}]+\}/g, 'x'),
  );
}

describe('route map (routes.yaml) against every service contract', () => {
  it('routes each public path to the service that owns it, and never exposes internal ones', () => {
    const problems: string[] = [];
    for (const service of PUBLIC_SERVICES) {
      for (const p of openapiPaths(service)) {
        const denied = routes.denied(p);
        const internal =
          p.startsWith('/v1/internal') ||
          p === '/healthz' ||
          p === '/readyz' ||
          p.startsWith('/v1/tenant-directory');
        if (internal) {
          if (!denied) problems.push(`${service} ${p}: internal but not denied`);
          continue;
        }
        if (denied) continue; // deliberately not exposed (service clients, signing keys)
        const r = routes.match(p);
        if (r?.service !== service)
          problems.push(`${service} ${p}: routed to ${r?.service ?? 'nothing'}`);
      }
    }
    expect(problems).toEqual([]);
  });

  it('keeps cell-internal services unreachable', () => {
    const exposed: string[] = [];
    for (const service of readdirSync(path.join(ROOT, 'services'))) {
      if (PUBLIC_SERVICES.includes(service) || service === 'parsing-svc') continue;
      let paths: string[] = [];
      try {
        paths = openapiPaths(service);
      } catch {
        continue;
      }
      for (const p of paths) {
        const r = routes.match(p);
        if (r && r.service === service && !routes.denied(p)) exposed.push(`${service} ${p}`);
      }
    }
    expect(exposed).toEqual([]);
    expect(routes.match('/v1/sandbox/languages')).toBeNull();
    expect(routes.denied('/v1/tenants/abc/ai-budget')).toBe(true);
  });

  it('matches segments, verbs and wildcards, most specific first', () => {
    expect(routes.match('/v1/candidates/c1/matches')?.service).toBe('matching-svc');
    expect(routes.match('/v1/candidates/c1/skills')?.service).toBe('profile-svc');
    expect(routes.match('/v1/invite-links/tok:redeem')).toMatchObject({
      service: 'assessment-svc',
      public: true,
    });
    expect(routes.match('/v1/invite-links/i1')).toMatchObject({ public: false });
    expect(routes.match('/v1/report-artifacts/a1:download')?.public).toBe(true);
    expect(routes.match('/v1/staff-accounts')?.service).toBe('identity-svc');
    expect(routes.match('/v1/nope')).toBeNull();
    expect(patternMatches('/v1/a/*:x', '/v1/a/b:y')).toBe(false);
    expect(patternMatches('/v1/a', '/v1')).toBe(false);
    expect(
      routes.upstream(
        { path: '/v1/x', service: 'report-svc', port: 8094, public: false, session: false },
        'eu-1',
      ),
    ).toBe('http://report-svc.eu-1.svc.cluster.local:8094');
    expect(routes.version).toBeGreaterThan(0);
  });

  it('refuses an invalid map', () => {
    const base = `version: 1\nupstream: 'http://{service}.{cell}:{port}'\nservices: { a: 1 }\nplatform: []\ndeny: []\n`;
    expect(() => parseRouteMap(`${base}routes: [{ path: /x, service: b }]`)).toThrow(
      /unknown service/,
    );
    expect(() =>
      parseRouteMap(`${base}routes: [{ path: /x, service: a }, { path: /x, service: a }]`),
    ).toThrow(/duplicate/);
    expect(() => parseRouteMap(`${base}routes: [{ path: /x/, service: a }]`)).toThrow(/trailing/);
  });
});

describe('host → tenant', () => {
  it.each([
    ['acme.atlas.test', { kind: 'tenant', slug: 'acme' }],
    ['ACME.atlas.test:443', { kind: 'tenant', slug: 'acme' }],
    ['acme.atlas.test.', { kind: 'tenant', slug: 'acme' }],
    ['atlas.test', { kind: 'platform' }],
    ['app.atlas.test', { kind: 'platform' }],
    ['a.b.atlas.test', { kind: 'foreign' }],
    ['-bad.atlas.test', { kind: 'foreign' }],
    ['evil.test', { kind: 'foreign' }],
    ['atlas.test.evil.test', { kind: 'foreign' }],
    [undefined, { kind: 'foreign' }],
  ])('%s', (host, expected) => {
    expect(hostTarget(host, 'atlas.test')).toEqual(expected);
  });
});

describe('TenantResolver', () => {
  const entry: DirectoryEntry = {
    tenant_id: 't',
    cell_id: 'c',
    data_region: 'eu',
    isolation_tier: 'pooled',
    status: 'active',
  };

  it('caches hits for 60 s and misses for 10 s, with one lookup in flight', async () => {
    expect([POSITIVE_TTL_MS, NEGATIVE_TTL_MS]).toEqual([60_000, 10_000]); // Component Prompt 14 §2
    const clock = new FixedClock(new Date('2026-11-06T09:00:00Z'));
    const calls: string[] = [];
    const r = new TenantResolver(
      { resolve: (s) => (calls.push(s), Promise.resolve(s === 'acme' ? entry : null)) },
      clock,
    );
    await Promise.all([r.resolve('acme'), r.resolve('acme'), r.resolve('acme')]);
    expect(calls).toEqual(['acme']);
    clock.advanceBy(POSITIVE_TTL_MS - 1);
    await r.resolve('acme');
    expect(calls).toHaveLength(1);
    clock.advanceBy(1);
    await r.resolve('acme');
    expect(calls).toHaveLength(2);
    expect(await r.resolve('ghost')).toBeNull();
    clock.advanceBy(NEGATIVE_TTL_MS - 1);
    await r.resolve('ghost');
    expect(calls.filter((c) => c === 'ghost')).toHaveLength(1);
    clock.advanceBy(1);
    await r.resolve('ghost');
    expect(calls.filter((c) => c === 'ghost')).toHaveLength(2);
  });

  it('serves a stale hit while the directory is down, within limits', async () => {
    const clock = new FixedClock(new Date('2026-11-06T09:00:00Z'));
    let down = false;
    const r = new TenantResolver(
      { resolve: () => (down ? Promise.reject(new Error('down')) : Promise.resolve(entry)) },
      clock,
      120_000,
      1,
    );
    await r.resolve('acme');
    down = true;
    clock.advanceBy(POSITIVE_TTL_MS + 1);
    expect(await r.resolve('acme')).toEqual(entry);
    clock.advanceBy(120_000);
    await expect(r.resolve('acme')).rejects.toThrow('down');
    await expect(r.resolve('new')).rejects.toThrow('down');
  });

  it('evicts the oldest entry at capacity', async () => {
    const clock = new FixedClock(new Date());
    const calls: string[] = [];
    const r = new TenantResolver(
      { resolve: (s) => (calls.push(s), Promise.resolve(entry)) },
      clock,
      1000,
      1,
    );
    await r.resolve('a');
    await r.resolve('b');
    await r.resolve('a');
    expect(calls).toEqual(['a', 'b', 'a']);
  });

  it('HTTP source: 404 is unknown, other errors throw', async () => {
    const responses = [
      new Response(JSON.stringify(entry)),
      new Response('{}', { status: 404 }),
      new Response('{}', { status: 503 }),
    ];
    const urls: string[] = [];
    const src = new HttpDirectorySource({
      baseUrl: 'http://tenant-svc/',
      token: () => Promise.resolve('t'),
      fetch: ((u: string) => (
        urls.push(u),
        Promise.resolve(responses.shift() as Response)
      )) as unknown as typeof fetch,
    });
    expect(await src.resolve('a b')).toEqual(entry);
    expect(urls[0]).toBe('http://tenant-svc/v1/tenant-directory:resolve?slug=a%20b');
    expect(await src.resolve('x')).toBeNull();
    await expect(src.resolve('x')).rejects.toThrow('HTTP 503');
  });
});

describe('pages', () => {
  it('escapes values into static pages', () => {
    const html = page('not-found.html', {
      host: '<script>x</script>.atlas.test',
      request_id: 'r"1',
    });
    expect(html).toContain('&lt;script&gt;x&lt;/script&gt;.atlas.test');
    expect(html).toContain('r&quot;1');
    expect(html).not.toMatch(/<script/);
    expect(escapeHtml(`&'`)).toBe('&amp;&#39;');
    expect(page('suspended.html', {})).toContain('temporarily unavailable');
  });
});

describe('config', () => {
  const base = {
    ATLAS_GATEWAY_BASE_DOMAIN: 'atlas.test',
    ATLAS_AUTH_ISSUER: 'https://id.atlas.test',
    ATLAS_AUTH_AUDIENCE: 'atlas',
    ATLAS_AUTH_SHARED_SECRET: 'x'.repeat(32),
    ATLAS_TENANT_SVC_URL: 'http://tenant-svc:8081',
    ATLAS_IDENTITY_TOKEN_URL: 'http://identity-svc:8082/v1/oauth/token',
    ATLAS_GATEWAY_CLIENT_ID: 'gw',
    ATLAS_GATEWAY_CLIENT_SECRET: 's',
  };
  it('defaults and production rules', () => {
    expect(loadGatewayConfig(base)).toMatchObject({
      ATLAS_GATEWAY_PORT: 8080,
      ATLAS_GATEWAY_RPM_POOLED: 1200,
    });
    expect(() => loadGatewayConfig({ ...base, ATLAS_AUTH_SHARED_SECRET: undefined })).toThrow(
      /JWKS/,
    );
    expect(() => loadGatewayConfig({ ...base, NODE_ENV: 'production' })).toThrow(
      /shared-secret|Redis/,
    );
  });
});
