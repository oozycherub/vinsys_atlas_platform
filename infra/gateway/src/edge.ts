import { randomUUID } from 'node:crypto';
import { type Logger } from 'pino';
import { type Principal, type RateLimiter, type TokenVerifier } from '@atlas/platform';
import { hostTarget } from './host';
import { page } from './pages';
import { type DirectoryEntry, type TenantResolver } from './resolver';
import { type Route, type RouteMap } from './route-map';

/**
 * The gateway's decision for one request (Component Prompt 14 §2), separate from the transport so
 * it can sit behind Envoy (ext_authz) or the Node proxy alike:
 *
 *   path hygiene → deny list → tenant from host (cached directory) → status pages → route →
 *   CORS → JWT pre-validation (tenant must match) → per-tenant rate limit → upstream in the cell.
 *
 * Services still authenticate and authorise every request; the gateway only rejects early.
 */
export interface EdgeRequest {
  method: string;
  /** Path and query as received. */
  url: string;
  headers: Record<string, string | string[] | undefined>;
  remoteAddress: string;
}

export type Decision =
  | {
      kind: 'proxy';
      upstream: string;
      headers: Record<string, string>;
      responseHeaders: Record<string, string>;
    }
  | { kind: 'page'; status: number; html: string; responseHeaders: Record<string, string> }
  | {
      kind: 'problem';
      status: number;
      code: string;
      title: string;
      responseHeaders: Record<string, string>;
    }
  | { kind: 'preflight'; status: number; responseHeaders: Record<string, string> };

export interface EdgeOptions {
  routes: RouteMap;
  resolver: TenantResolver;
  verifier: TokenVerifier;
  limiter: RateLimiter;
  /** e.g. `atlas.example` → tenants at `<slug>.atlas.example`, the platform at `app.atlas.example`. */
  baseDomain: string;
  /** Requests per minute per tenant, by isolation tier; anonymous calls per client IP. */
  limits: { pooled: number; dedicated: number; anonymous: number };
  logger?: Logger;
}

const REQUEST_ID = /^[A-Za-z0-9_.:-]{8,128}$/;
/** Opaque candidate credentials: assessment session, proctoring and AI-interview tokens. */
const CANDIDATE_TOKEN =
  /^(?:(?:Session\s+ast_|Proctor\s+apt_)[A-Za-z0-9_-]{20,100}|Interview\s+[A-Za-z0-9_.-]{20,200})$/;
const CLIENT_CONTROLLED = /^(x-atlas-|x-forwarded-|forwarded$|x-real-ip$)/i;
const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  'host',
]);

function header(req: EdgeRequest, name: string): string | undefined {
  const v = req.headers[name];
  return Array.isArray(v) ? v[0] : v;
}

function wantsHtml(req: EdgeRequest, path: string): boolean {
  return !path.startsWith('/v1/') && (header(req, 'accept') ?? '').includes('text/html');
}

export class Edge {
  constructor(private readonly o: EdgeOptions) {}

  private problem(
    status: number,
    code: string,
    title: string,
    extra: Record<string, string> = {},
  ): Decision {
    return { kind: 'problem', status, code, title, responseHeaders: extra };
  }

  async decide(req: EdgeRequest): Promise<Decision & { requestId: string }> {
    const incoming = header(req, 'x-request-id');
    const requestId = incoming && REQUEST_ID.test(incoming) ? incoming : randomUUID();
    const d = await this.decideInner(req, requestId);
    return {
      ...d,
      requestId,
      responseHeaders: { ...d.responseHeaders, 'x-request-id': requestId },
    };
  }

  private async decideInner(req: EdgeRequest, requestId: string): Promise<Decision> {
    const [rawPath = '/', query = ''] = req.url.split(/\?(.*)/s);
    // Path hygiene: no traversal, no encoded separators, no empty segments.
    if (/%2f|%5c|%2e%2e|\/\.\.?(\/|$)|\/\/|\\/i.test(rawPath))
      return this.problem(400, 'INVALID_PATH', 'The request path is not valid.');
    const path = rawPath;
    if (this.o.routes.denied(path)) return this.problem(404, 'NOT_FOUND', 'Not found.');

    const host = header(req, 'host') ?? '';
    const target = hostTarget(host, this.o.baseDomain);
    const html = wantsHtml(req, path);
    if (target.kind === 'foreign')
      return this.problem(421, 'MISDIRECTED_REQUEST', 'This host is not served here.');

    let entry: DirectoryEntry | null = null;
    if (target.kind === 'tenant') {
      try {
        entry = await this.o.resolver.resolve(target.slug);
      } catch (error) {
        this.o.logger?.error(
          { err: error, slug: target.slug, request_id: requestId },
          'tenant directory unavailable',
        );
        return html
          ? this.pageOf(503, 'unavailable.html', host, requestId)
          : this.problem(503, 'DIRECTORY_UNAVAILABLE', 'Please retry shortly.', {
              'retry-after': '5',
            });
      }
      if (!entry || entry.status === 'purged')
        return html
          ? this.pageOf(404, 'not-found.html', host, requestId)
          : this.problem(404, 'TENANT_NOT_FOUND', 'No workspace at this address.');
      if (entry.status === 'suspended' || entry.status === 'offboarding')
        return html
          ? this.pageOf(403, 'suspended.html', host, requestId)
          : this.problem(403, 'TENANT_SUSPENDED', 'This workspace is suspended.');
      if (entry.status === 'provisioning')
        return html
          ? this.pageOf(503, 'unavailable.html', host, requestId)
          : this.problem(503, 'TENANT_PROVISIONING', 'This workspace is not ready yet.');
    } else if (!this.o.routes.platform(path)) {
      return this.problem(404, 'NOT_FOUND', 'Not found.');
    }

    const route = this.o.routes.match(path);
    if (!route) return this.problem(404, 'NOT_FOUND', 'Not found.');

    const cors = this.cors(req, host);
    if (cors === 'forbidden')
      return this.problem(403, 'CORS_ORIGIN_DENIED', 'This origin may not call the API.');
    if (req.method === 'OPTIONS' && header(req, 'access-control-request-method'))
      return {
        kind: 'preflight',
        status: 204,
        responseHeaders: { ...cors, 'access-control-max-age': '600' },
      };

    let principal: Principal | null = null;
    const auth = header(req, 'authorization');
    if (auth && route.session && CANDIDATE_TOKEN.test(auth)) {
      // A candidate's session or proctoring token: opaque here, verified by the service.
    } else if (auth) {
      const m = /^Bearer\s+(\S+)$/i.exec(auth);
      if (!m?.[1])
        return this.problem(401, 'UNAUTHENTICATED', 'Invalid Authorization header.', cors);
      try {
        principal = await this.o.verifier.verify(m[1]);
      } catch {
        return this.problem(401, 'UNAUTHENTICATED', 'The token is not valid.', {
          ...cors,
          'www-authenticate': 'Bearer',
        });
      }
      if (principal.roles.includes('service'))
        return this.problem(403, 'FORBIDDEN', 'Service tokens are not accepted at the edge.', cors);
      // A tenant token works only on its own tenant's host; platform staff only on platform hosts.
      if (entry ? principal.tenantId !== entry.tenant_id : principal.tenantId !== null)
        return this.problem(403, 'WRONG_TENANT', 'This token belongs to another workspace.', cors);
    } else if (!route.public) {
      return this.problem(401, 'UNAUTHENTICATED', 'Sign in to continue.', {
        ...cors,
        'www-authenticate': 'Bearer',
      });
    }

    const limit = entry ? this.o.limits[entry.isolation_tier] : this.o.limits.anonymous;
    const key = entry ? `gw:tenant:${entry.tenant_id}` : `gw:ip:${req.remoteAddress}`;
    const verdict = await this.o.limiter.consume(key, limit, 60);
    if (!verdict.allowed)
      return this.problem(429, 'RATE_LIMITED', 'Too many requests.', {
        ...cors,
        'retry-after': String(verdict.retryAfterSec),
      });

    return {
      kind: 'proxy',
      upstream: `${this.upstream(route, entry)}${path}${query ? `?${query}` : ''}`,
      headers: this.forwardHeaders(req, requestId, entry, host, principal),
      responseHeaders: cors,
    };
  }

  private upstream(route: Route, entry: DirectoryEntry | null): string {
    return this.o.routes.upstream(route, entry?.cell_id ?? 'platform');
  }

  private pageOf(
    status: number,
    name: 'not-found.html' | 'suspended.html' | 'unavailable.html',
    host: string,
    requestId: string,
  ): Decision {
    return {
      kind: 'page',
      status,
      html: page(name, { host, request_id: requestId }),
      responseHeaders: {},
    };
  }

  /** Same-workspace origins only: the tenant's own host (or the platform app on platform hosts). */
  private cors(req: EdgeRequest, host: string): Record<string, string> | 'forbidden' {
    const origin = header(req, 'origin');
    if (!origin) return {};
    let originHost: string;
    try {
      const u = new URL(origin);
      if (u.protocol !== 'https:' && !u.hostname.endsWith('.localhost')) return 'forbidden';
      originHost = u.host;
    } catch {
      return 'forbidden';
    }
    const hostOnly = host.toLowerCase().replace(/:\d+$/, '');
    const allowed =
      originHost.replace(/:\d+$/, '') === hostOnly ||
      (hostTarget(hostOnly, this.o.baseDomain).kind === 'platform' &&
        hostTarget(originHost, this.o.baseDomain).kind === 'platform');
    if (!allowed) return 'forbidden';
    return {
      'access-control-allow-origin': origin,
      'access-control-allow-credentials': 'true',
      'access-control-allow-methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
      'access-control-allow-headers':
        'Authorization, Content-Type, Idempotency-Key, If-Match, Last-Event-ID, X-Request-Id',
      'access-control-expose-headers': 'ETag, Retry-After, X-Request-Id, Location',
      vary: 'Origin',
    };
  }

  private forwardHeaders(
    req: EdgeRequest,
    requestId: string,
    entry: DirectoryEntry | null,
    host: string,
    principal: Principal | null,
  ): Record<string, string> {
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(req.headers)) {
      if (v === undefined || HOP_BY_HOP.has(k.toLowerCase()) || CLIENT_CONTROLLED.test(k)) continue;
      out[k.toLowerCase()] = Array.isArray(v) ? v.join(', ') : v;
    }
    out['x-request-id'] = requestId;
    out['x-forwarded-host'] = host;
    out['x-forwarded-proto'] = 'https';
    out['x-forwarded-for'] = req.remoteAddress;
    if (entry) {
      out['x-atlas-tenant-id'] = entry.tenant_id;
      out['x-atlas-cell'] = entry.cell_id;
    }
    if (principal) out['x-atlas-subject'] = principal.subject;
    return out;
  }
}
