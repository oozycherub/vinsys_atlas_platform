import { type IsolationTier } from '@atlas/contracts';
import { TenantDomainError } from './errors';

/** Configured cells per data region (ADR-0001). Example: { "eu-central-1": { pooled: ["eu-pool-01"] } }. */
export type CellTopology = Readonly<Record<string, { readonly pooled: readonly string[] }>>;

/** 32-bit FNV-1a: tiny, stable across runtimes, good enough to spread tenants over a few cells. */
export function fnv1a(input: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

/** Returns the region's pooled cells, or raises UNSUPPORTED_DATA_REGION. */
export function assertSupportedRegion(topology: CellTopology, region: string): readonly string[] {
  const pooled = topology[region]?.pooled ?? [];
  if (pooled.length === 0) {
    throw new TenantDomainError(
      'rule',
      'UNSUPPORTED_DATA_REGION',
      `No cell serves data region "${region}". Supported: ${Object.keys(topology).sort().join(', ')}.`,
    );
  }
  return pooled;
}

/**
 * Dedicated tenants get their own cell name; pooled tenants are spread deterministically over the
 * region's pooled cells so a retried request lands in the same cell.
 */
export function placeTenant(
  topology: CellTopology,
  input: { tenantId: string; slug: string; region: string; tier: IsolationTier },
): string {
  const pooled = assertSupportedRegion(topology, input.region);
  if (input.tier === 'dedicated') return `${input.region}-dedicated-${input.slug}`;
  return pooled[fnv1a(input.tenantId) % pooled.length] ?? pooled[0] ?? '';
}
