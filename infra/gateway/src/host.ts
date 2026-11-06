/**
 * Tenant from the Host header (PRD §1.2.2): `<slug>.<base domain>`. The platform's own hosts
 * (the bare domain, `app.`, `www.`, `admin.`) carry no tenant.
 */
export const RESERVED = new Set(['app', 'www', 'admin', 'api', 'status', 'docs']);
const SLUG = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

export type HostTarget =
  { kind: 'tenant'; slug: string } | { kind: 'platform' } | { kind: 'foreign' };

export function hostTarget(rawHost: string | undefined, baseDomain: string): HostTarget {
  const host = (rawHost ?? '').toLowerCase().replace(/:\d+$/, '').replace(/\.$/, '');
  const base = baseDomain.toLowerCase();
  if (host === base) return { kind: 'platform' };
  if (!host.endsWith(`.${base}`)) return { kind: 'foreign' };
  const label = host.slice(0, -(base.length + 1));
  if (label.includes('.') || !SLUG.test(label)) return { kind: 'foreign' };
  return RESERVED.has(label) ? { kind: 'platform' } : { kind: 'tenant', slug: label };
}
