/**
 * The signed-in user's session. The access token lives in sessionStorage (tab-scoped, gone when
 * the tab closes) behind a strict CSP. Claims are read only to choose what to show: the UI never
 * decides authorisation; every API call is authorised by the services (Component Prompt 14 §6).
 */
export interface Session {
  accessToken: string;
  expiresAt: number;
}

export interface Claims {
  sub: string;
  tid: string | null;
  roles: string[];
  scopes: string[];
}

const KEY = 'atlas.session';

export function decodeClaims(token: string): Claims | null {
  const part = token.split('.')[1];
  if (!part) return null;
  try {
    const json = JSON.parse(atob(part.replace(/-/g, '+').replace(/_/g, '/'))) as Record<
      string,
      unknown
    >;
    return {
      sub: String(json['sub'] ?? ''),
      tid: (json['tid'] as string | null | undefined) ?? null,
      roles: Array.isArray(json['roles']) ? (json['roles'] as string[]) : [],
      scopes: Array.isArray(json['scopes']) ? (json['scopes'] as string[]) : [],
    };
  } catch {
    return null;
  }
}

export function saveSession(token: string, expiresInSec: number, now = Date.now()): void {
  const s: Session = { accessToken: token, expiresAt: now + expiresInSec * 1000 };
  sessionStorage.setItem(KEY, JSON.stringify(s));
  window.dispatchEvent(new Event('atlas:session'));
}

export function loadSession(now = Date.now()): Session | null {
  if (typeof sessionStorage === 'undefined') return null;
  try {
    const s = JSON.parse(sessionStorage.getItem(KEY) ?? 'null') as Session | null;
    return s && s.expiresAt > now ? s : null;
  } catch {
    return null;
  }
}

export function clearSession(): void {
  sessionStorage.removeItem(KEY);
  window.dispatchEvent(new Event('atlas:session'));
}

/** The workspace slug: the first label of the host, or the dev override on localhost. */
export function tenantSlug(hostname: string): string {
  const override = process.env['NEXT_PUBLIC_ATLAS_TENANT'];
  if (hostname === 'localhost' || hostname === '127.0.0.1') return override ?? 'dev';
  return hostname.split('.')[0] ?? '';
}

export type Portal = 'admin' | 'recruiter' | 'employee';

/** Where a user lands after sign-in (most capable portal first). */
export function homeFor(claims: Claims | null): string {
  if (!claims) return '/login';
  if (claims.roles.includes('tenant_admin')) return '/admin';
  if (claims.roles.some((r) => ['recruiter', 'hiring_manager', 'reviewer', 'sme'].includes(r)))
    return '/recruiter';
  return '/employee';
}

export function portalsFor(claims: Claims | null): Portal[] {
  if (!claims) return [];
  const out: Portal[] = [];
  if (claims.roles.includes('tenant_admin')) out.push('admin');
  if (
    claims.roles.some((r) =>
      ['tenant_admin', 'recruiter', 'hiring_manager', 'reviewer', 'sme'].includes(r),
    )
  )
    out.push('recruiter');
  if (claims.roles.some((r) => ['employee', 'hiring_manager', 'tenant_admin'].includes(r)))
    out.push('employee');
  return out;
}
