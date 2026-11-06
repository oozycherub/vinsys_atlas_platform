import { readFileSync } from 'node:fs';
import { parse } from 'yaml';
import { z } from 'zod';

/**
 * The versioned route map (`routes.yaml`, Component Prompt 14 §4). Patterns are path segments
 * with `*` for one segment; a custom verb (`:publish`) belongs to its segment, and a pattern
 * without a verb matches the segment whatever its verb.
 */
const pattern = z
  .string()
  .regex(/^\/[A-Za-z0-9._\-*/:]*$/, 'a path pattern')
  .refine((p) => !p.endsWith('/') || p === '/', 'no trailing slash');

const schema = z
  .object({
    version: z.number().int().positive(),
    upstream: z.string().includes('{service}').includes('{cell}').includes('{port}'),
    services: z.record(z.number().int().min(1).max(65535)),
    platform: z.array(pattern),
    deny: z.array(pattern),
    routes: z.array(
      z
        .object({
          path: pattern,
          service: z.string(),
          public: z.boolean().default(false),
          /** Candidate routes: `Session ast_…` / `Proctor apt_…` tokens, checked by the service itself. */
          session: z.boolean().default(false),
        })
        .strict(),
    ),
  })
  .strict()
  .superRefine((m, ctx) => {
    const seen = new Set<string>();
    for (const r of m.routes) {
      if (!(r.service in m.services))
        ctx.addIssue({ code: 'custom', message: `route ${r.path}: unknown service ${r.service}` });
      if (seen.has(r.path)) ctx.addIssue({ code: 'custom', message: `duplicate route ${r.path}` });
      seen.add(r.path);
    }
  });

export type RouteMapFile = z.output<typeof schema>;

export interface Route {
  path: string;
  service: string;
  port: number;
  public: boolean;
  session: boolean;
}

export interface RouteMap {
  version: number;
  match(path: string): Route | null;
  denied(path: string): boolean;
  /** Paths served without a tenant subdomain. */
  platform(path: string): boolean;
  upstream(route: Route, cell: string): string;
}

function segments(path: string): string[] {
  return path.split('/').filter(Boolean);
}

/** One request segment against one pattern segment. */
function segmentMatches(pattern: string, actual: string): boolean {
  if (pattern === '*') return true;
  const [pName, pVerb] = pattern.split(':');
  const [aName, aVerb] = actual.split(':');
  if (pName === '*') return pVerb === aVerb;
  return pName === aName && (pVerb === undefined || pVerb === aVerb);
}

export function patternMatches(pattern: string, path: string): boolean {
  const p = segments(pattern);
  const a = segments(path);
  if (a.length < p.length) return false;
  return p.every((seg, i) => segmentMatches(seg, a[i] as string));
}

/** More literal segments first, then longer patterns. */
function specificity(pattern: string): number {
  const segs = segments(pattern);
  return (
    segs.filter((s) => !s.startsWith('*')).length * 100 +
    segs.length * 10 +
    (pattern.includes(':') ? 1 : 0)
  );
}

export function buildRouteMap(file: RouteMapFile): RouteMap {
  const routes: Route[] = file.routes
    .map((r) => ({
      path: r.path,
      service: r.service,
      port: file.services[r.service] as number,
      public: r.public,
      session: r.session,
    }))
    .sort((a, b) => specificity(b.path) - specificity(a.path));
  return {
    version: file.version,
    match: (path) => routes.find((r) => patternMatches(r.path, path)) ?? null,
    denied: (path) => file.deny.some((d) => patternMatches(d, path)),
    platform: (path) => file.platform.some((d) => patternMatches(d, path)),
    upstream: (route, cell) =>
      file.upstream
        .replace('{service}', route.service)
        .replace('{cell}', cell)
        .replace('{port}', String(route.port)),
  };
}

export function parseRouteMap(text: string): RouteMap {
  return buildRouteMap(schema.parse(parse(text)));
}

export function loadRouteMap(file: string): RouteMap {
  return parseRouteMap(readFileSync(file, 'utf8'));
}
