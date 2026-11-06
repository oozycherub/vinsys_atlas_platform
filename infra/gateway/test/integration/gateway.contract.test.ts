/**
 * Component Prompt 14 §8 gateway acceptance: unknown subdomain → 404 page, suspended tenant → 403
 * page, and cross-cell routing, against the real proxy with stubbed cells (one HTTP server per
 * cell that echoes what it received).
 */
import { createServer, type IncomingMessage, request, type Server } from 'node:http';
import { type AddressInfo } from 'node:net';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FixedClock, JwtVerifier, MemoryRateLimiter, newId } from '@atlas/platform';
import { signTestToken, TEST_AUTH } from '@atlas/platform/testing';
import { Edge } from '../../src/edge';
import { createGatewayServer } from '../../src/proxy';
import { type DirectoryEntry, TenantResolver } from '../../src/resolver';
import { loadRouteMap, type RouteMap } from '../../src/route-map';

interface Echo {
  cell: string;
  method: string;
  url: string;
  headers: IncomingMessage['headers'];
  body: string;
}

function stubCell(cell: string): Promise<Server> {
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (c: Buffer) => (body += c.toString()));
    req.on('end', () => {
      if (req.url?.startsWith('/v1/me/notifications:stream')) {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.write('event: unread\ndata: {"unread":1}\n\n');
        setTimeout(() => res.end('event: unread\ndata: {"unread":2}\n\n'), 20);
        return;
      }
      const echo: Echo = {
        cell,
        method: req.method ?? '',
        url: req.url ?? '',
        headers: req.headers,
        body,
      };
      res.writeHead(200, {
        'content-type': 'application/json',
        server: 'stub',
        'x-powered-by': 'stub',
      });
      res.end(JSON.stringify(echo));
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

const port = (s: Server) => (s.address() as AddressInfo).port;

describe('gateway contract (stubbed cells)', () => {
  const clock = new FixedClock(new Date('2026-11-06T09:00:00Z'));
  const A = newId();
  const B = newId();
  const directory = new Map<string, DirectoryEntry>([
    [
      'acme',
      {
        tenant_id: A,
        cell_id: 'cell-eu-1',
        data_region: 'eu',
        isolation_tier: 'pooled',
        status: 'active',
      },
    ],
    [
      'globex',
      {
        tenant_id: B,
        cell_id: 'cell-us-1',
        data_region: 'us',
        isolation_tier: 'dedicated',
        status: 'active',
      },
    ],
    [
      'frozen',
      {
        tenant_id: newId(),
        cell_id: 'cell-eu-1',
        data_region: 'eu',
        isolation_tier: 'pooled',
        status: 'suspended',
      },
    ],
    [
      'gone',
      {
        tenant_id: newId(),
        cell_id: 'cell-eu-1',
        data_region: 'eu',
        isolation_tier: 'pooled',
        status: 'purged',
      },
    ],
    [
      'newco',
      {
        tenant_id: newId(),
        cell_id: 'cell-eu-1',
        data_region: 'eu',
        isolation_tier: 'pooled',
        status: 'provisioning',
      },
    ],
  ]);
  let directoryDown = false;
  const lookups: string[] = [];
  const cells: Record<string, Server> = {};
  let gateway: Server;
  const tok: Record<string, string> = {};

  interface Reply {
    status: number;
    headers: { get(name: string): string | null };
    text(): Promise<string>;
    json(): Promise<unknown>;
  }
  /** Raw HTTP (fetch would replace the Host header and normalise the path). */
  const call = (
    host: string,
    p: string,
    init: { method?: string; body?: string; headers?: Record<string, string> } = {},
  ) =>
    new Promise<Reply>((resolve, reject) => {
      const req = request(
        {
          host: '127.0.0.1',
          port: port(gateway),
          path: p,
          method: init.method ?? 'GET',
          headers: { host, ...(init.headers ?? {}) },
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (c: Buffer) => chunks.push(c));
          res.on('end', () => {
            const text = Buffer.concat(chunks).toString('utf8');
            resolve({
              status: res.statusCode ?? 0,
              headers: {
                get: (n) => {
                  const v = res.headers[n.toLowerCase()];
                  return v === undefined ? null : Array.isArray(v) ? v.join(', ') : v;
                },
              },
              text: () => Promise.resolve(text),
              json: () => Promise.resolve(JSON.parse(text) as unknown),
            });
          });
        },
      );
      req.on('error', reject);
      req.end(init.body);
    });

  beforeAll(async () => {
    cells['cell-eu-1'] = await stubCell('cell-eu-1');
    cells['cell-us-1'] = await stubCell('cell-us-1');
    cells['platform'] = await stubCell('platform');
    const file = loadRouteMap(path.resolve(__dirname, '../../routes.yaml'));
    const routes: RouteMap = {
      ...file,
      // Each cell is one stub server; the real template is checked in the unit tests.
      upstream: (_route, cell) =>
        `http://127.0.0.1:${cells[cell] ? port(cells[cell] as Server) : 1}`,
    };
    const edge = new Edge({
      routes,
      resolver: new TenantResolver(
        {
          resolve: (slug) => {
            lookups.push(slug);
            return directoryDown
              ? Promise.reject(new Error('down'))
              : Promise.resolve(directory.get(slug) ?? null);
          },
        },
        clock,
      ),
      verifier: new JwtVerifier({ ...TEST_AUTH }),
      limiter: new MemoryRateLimiter(clock),
      baseDomain: 'atlas.test',
      limits: { pooled: 1000, dedicated: 5, anonymous: 1000 },
    });
    gateway = createGatewayServer(edge);
    await new Promise<void>((r) => gateway.listen(0, '127.0.0.1', () => r()));
    const sign = (sub: string, tid: string | null, roles: string[]) =>
      signTestToken({ sub, tid, roles: roles as never, scopes: [], expiresIn: '1h' });
    Object.assign(tok, {
      a: await sign('u-a', A, ['recruiter']),
      b: await sign('u-b', B, ['tenant_admin']),
      staff: await sign('staff-1', null, ['super_admin']),
      service: await sign('svc', A, ['service']),
    });
  });

  afterAll(async () => {
    await new Promise((r) => gateway.close(r));
    for (const s of Object.values(cells)) await new Promise((r) => s.close(r));
  });

  it('unknown subdomain → branded 404 page (HTML) or problem (API)', async () => {
    const res = await call('nobody.atlas.test', '/', { headers: { accept: 'text/html' } });
    expect(res.status).toBe(404);
    expect(res.headers.get('content-type')).toContain('text/html');
    expect(res.headers.get('content-security-policy')).toContain("default-src 'none'");
    const html = await res.text();
    expect(html).toContain('We couldn’t find this workspace');
    expect(html).toContain('nobody.atlas.test');
    const api = await call('nobody.atlas.test', '/v1/assessments', {
      headers: { authorization: `Bearer ${tok['a']}` },
    });
    expect(api.status).toBe(404);
    expect(await api.json()).toMatchObject({ code: 'TENANT_NOT_FOUND' });
    expect((await call('gone.atlas.test', '/', { headers: { accept: 'text/html' } })).status).toBe(
      404,
    );
  });

  it('suspended tenant → branded 403 page; provisioning → 503', async () => {
    const res = await call('frozen.atlas.test', '/admin', { headers: { accept: 'text/html' } });
    expect(res.status).toBe(403);
    expect(await res.text()).toContain('temporarily unavailable');
    const api = await call('frozen.atlas.test', '/v1/assessments', {
      headers: { authorization: `Bearer ${tok['a']}` },
    });
    expect(await api.json()).toMatchObject({ status: 403, code: 'TENANT_SUSPENDED' });
    expect((await call('newco.atlas.test', '/v1/assessments')).status).toBe(503);
  });

  it('routes each tenant to its own cell, with trusted headers only', async () => {
    const a = await call('acme.atlas.test', '/v1/assessments?limit=5', {
      headers: {
        authorization: `Bearer ${tok['a']}`,
        'x-atlas-tenant-id': B,
        'x-forwarded-for': '6.6.6.6',
        'x-request-id': 'req-12345678',
      },
    });
    expect(a.status).toBe(200);
    expect(a.headers.get('x-request-id')).toBe('req-12345678');
    expect(a.headers.get('x-powered-by')).toBeNull();
    const ea = (await a.json()) as Echo;
    expect(ea).toMatchObject({ cell: 'cell-eu-1', url: '/v1/assessments?limit=5' });
    expect(ea.headers['x-atlas-tenant-id']).toBe(A); // the client's spoofed value is gone
    expect(ea.headers['x-atlas-cell']).toBe('cell-eu-1');
    expect(ea.headers['x-forwarded-for']).toBe('127.0.0.1');
    expect(ea.headers['x-forwarded-host']).toBe('acme.atlas.test');
    expect(ea.headers['authorization']).toBe(`Bearer ${tok['a']}`);

    const b = await call('globex.atlas.test', '/v1/reports', {
      method: 'POST',
      body: '{"type":"x"}',
      headers: { authorization: `Bearer ${tok['b']}`, 'content-type': 'application/json' },
    });
    const eb = (await b.json()) as Echo;
    expect(eb).toMatchObject({ cell: 'cell-us-1', method: 'POST', body: '{"type":"x"}' });
    expect(eb.headers['x-atlas-tenant-id']).toBe(B);
    expect(eb.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('pre-validates tokens: missing, invalid, another tenant’s, or a service token', async () => {
    expect((await call('acme.atlas.test', '/v1/assessments')).status).toBe(401);
    expect(
      (
        await call('acme.atlas.test', '/v1/assessments', {
          headers: { authorization: 'Bearer nope' },
        })
      ).status,
    ).toBe(401);
    expect(
      (await call('acme.atlas.test', '/v1/assessments', { headers: { authorization: 'Basic x' } }))
        .status,
    ).toBe(401);
    const cross = await call('acme.atlas.test', '/v1/assessments', {
      headers: { authorization: `Bearer ${tok['b']}` },
    });
    expect(cross.status).toBe(403);
    expect(await cross.json()).toMatchObject({ code: 'WRONG_TENANT' });
    expect(
      (
        await call('acme.atlas.test', '/v1/assessments', {
          headers: { authorization: `Bearer ${tok['staff']}` },
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await call('acme.atlas.test', '/v1/assessments', {
          headers: { authorization: `Bearer ${tok['service']}` },
        })
      ).status,
    ).toBe(403);
    // Identity headers are the gateway's to set: a client's copies never reach a service.
    const spoof = await call('acme.atlas.test', '/v1/auth/magic-links', {
      method: 'POST',
      headers: {
        'x-atlas-subject': 'admin',
        'x-atlas-cell': 'cell-us-1',
        forwarded: 'for=6.6.6.6',
        'x-real-ip': '6.6.6.6',
      },
    });
    const echoed = ((await spoof.json()) as Echo).headers;
    for (const h of ['x-atlas-subject', 'forwarded', 'x-real-ip'])
      expect(echoed[h], h).toBeUndefined();
    expect(echoed['x-atlas-cell']).toBe('cell-eu-1');
    // Candidates carry an opaque session token on runner routes only.
    expect(
      (
        await call('acme.atlas.test', '/v1/interview-sessions/s1:join', {
          method: 'POST',
          headers: { authorization: `Interview ${'z'.repeat(30)}` },
        })
      ).status,
    ).toBe(200);
    const session = { authorization: `Session ast_${'x'.repeat(40)}` };
    expect(
      (await call('acme.atlas.test', '/v1/sessions/s1/questions/1', { headers: session })).status,
    ).toBe(200);
    expect((await call('acme.atlas.test', '/v1/assessments', { headers: session })).status).toBe(
      401,
    );
    expect(
      (
        await call('acme.atlas.test', '/v1/sessions/s1', {
          headers: { authorization: 'Session nope' },
        })
      ).status,
    ).toBe(401);
    // Public routes need no token: invite redemption and sign-in.
    expect(
      (await call('acme.atlas.test', '/v1/invite-links/tok123:redeem', { method: 'POST' })).status,
    ).toBe(200);
    expect((await call('acme.atlas.test', '/v1/auth/magic-links', { method: 'POST' })).status).toBe(
      200,
    );
  });

  it('serves platform paths on platform hosts only, to platform tokens', async () => {
    const res = await call('app.atlas.test', '/v1/tenants', {
      headers: { authorization: `Bearer ${tok['staff']}` },
    });
    expect(((await res.json()) as Echo).cell).toBe('platform');
    expect(
      (
        await call('app.atlas.test', '/v1/assessments', {
          headers: { authorization: `Bearer ${tok['staff']}` },
        })
      ).status,
    ).toBe(404);
    expect(
      (
        await call('app.atlas.test', '/v1/tenants', {
          headers: { authorization: `Bearer ${tok['a']}` },
        })
      ).status,
    ).toBe(403);
    expect((await call('elsewhere.test', '/v1/tenants')).status).toBe(421);
  });

  it('never exposes internal APIs, and rejects path tricks', async () => {
    const h = { authorization: `Bearer ${tok['a']}` };
    for (const p of [
      '/v1/internal/link-messages',
      '/v1/tenant-directory:resolve?slug=acme',
      '/healthz',
      '/v1/tenants/x/ai-budget',
    ])
      expect((await call('acme.atlas.test', p, { headers: h })).status, p).toBe(404);
    for (const p of [
      '/v1/assessments/%2e%2e/internal',
      '/v1/assessments/..%2Finternal',
      '/v1//internal',
    ])
      expect((await call('acme.atlas.test', p, { headers: h })).status, p).toBe(400);
    expect((await call('acme.atlas.test', '/v1/unknown', { headers: h })).status).toBe(404);
  });

  it('CORS: same-workspace origins only', async () => {
    const ok = await call('acme.atlas.test', '/v1/assessments', {
      method: 'OPTIONS',
      headers: { origin: 'https://acme.atlas.test', 'access-control-request-method': 'POST' },
    });
    expect(ok.status).toBe(204);
    expect(ok.headers.get('access-control-allow-origin')).toBe('https://acme.atlas.test');
    expect(ok.headers.get('access-control-allow-headers')).toContain('Idempotency-Key');
    for (const origin of [
      'https://globex.atlas.test',
      'https://evil.test',
      'http://acme.atlas.test',
      'null',
    ])
      expect(
        (
          await call('acme.atlas.test', '/v1/assessments', {
            method: 'OPTIONS',
            headers: { origin, 'access-control-request-method': 'GET' },
          })
        ).status,
        origin,
      ).toBe(403);
    const real = await call('acme.atlas.test', '/v1/assessments', {
      headers: { origin: 'https://acme.atlas.test', authorization: `Bearer ${tok['a']}` },
    });
    expect(real.headers.get('access-control-allow-origin')).toBe('https://acme.atlas.test');
  });

  it('rate-limits per tenant by tier', async () => {
    // globex is dedicated with 5 a minute in this test; one was used above.
    const statuses: number[] = [];
    for (let i = 0; i < 6; i++)
      statuses.push(
        (
          await call('globex.atlas.test', '/v1/reports', {
            headers: { authorization: `Bearer ${tok['b']}` },
          })
        ).status,
      );
    expect(statuses.filter((s) => s === 429).length).toBeGreaterThan(0);
    const limited = await call('globex.atlas.test', '/v1/reports', {
      headers: { authorization: `Bearer ${tok['b']}` },
    });
    expect(limited.headers.get('retry-after')).toMatch(/^\d+$/);
    // Another tenant is unaffected.
    expect(
      (
        await call('acme.atlas.test', '/v1/assessments', {
          headers: { authorization: `Bearer ${tok['a']}` },
        })
      ).status,
    ).toBe(200);
    clock.advanceBy(61_000);
  });

  it('streams server-sent events through', async () => {
    const res = await call('acme.atlas.test', '/v1/me/notifications:stream', {
      headers: { authorization: `Bearer ${tok['a']}` },
    });
    expect(res.headers.get('content-type')).toBe('text/event-stream');
    const text = await res.text();
    expect(text).toContain('{"unread":1}');
    expect(text).toContain('{"unread":2}');
  });

  it('caches the directory, and reports outages', async () => {
    const before = lookups.filter((s) => s === 'acme').length;
    await call('acme.atlas.test', '/v1/assessments', {
      headers: { authorization: `Bearer ${tok['a']}` },
    });
    expect(lookups.filter((s) => s === 'acme').length).toBe(before); // within 60 s
    directoryDown = true;
    const res = await call('initech.atlas.test', '/', { headers: { accept: 'text/html' } });
    expect(res.status).toBe(503);
    const api = await call('initech.atlas.test', '/v1/assessments');
    expect(api.headers.get('retry-after')).toBe('5');
    directoryDown = false;
  });

  it('upstream down → 502', async () => {
    const saved = cells['cell-eu-1'];
    delete cells['cell-eu-1'];
    const res = await call('acme.atlas.test', '/v1/assessments', {
      headers: { authorization: `Bearer ${tok['a']}` },
    });
    expect(res.status).toBe(502);
    expect(await res.json()).toMatchObject({ code: 'UPSTREAM_UNAVAILABLE' });
    const html = await call('acme.atlas.test', '/', {
      headers: { accept: 'text/html', authorization: `Bearer ${tok['a']}` },
    });
    expect(html.status).toBe(404); // the web app is not behind /v1; no route for "/"
    cells['cell-eu-1'] = saved as Server;
  });
});
