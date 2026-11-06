import { type IsolationTier, type TenantStatus } from '@atlas/contracts';
import { type RetentionPolicy, type TenantSettings } from '../domain/settings';
import { type Tenant } from '../domain/tenant';

/** Public representation (snake_case, ISO dates). Deliberately omits key material and KMS refs. */
export interface TenantView {
  tenant_id: string;
  slug: string;
  display_name: string;
  isolation_tier: IsolationTier;
  status: TenantStatus;
  cell_id: string;
  data_region: string;
  dek_version: number;
  settings: TenantSettings;
  retention_policy: RetentionPolicy;
  purge_not_before: string | null;
  version: number;
  created_at: string;
  updated_at: string;
  purged_at: string | null;
}

export function toView(tenant: Tenant): TenantView {
  return {
    tenant_id: tenant.id,
    slug: tenant.slug,
    display_name: tenant.displayName,
    isolation_tier: tenant.isolationTier,
    status: tenant.status,
    cell_id: tenant.cellId,
    data_region: tenant.dataRegion,
    dek_version: tenant.dekVersion,
    settings: tenant.settings,
    retention_policy: tenant.retentionPolicy,
    purge_not_before: tenant.purgeNotBefore?.toISOString() ?? null,
    version: tenant.version,
    created_at: tenant.createdAt.toISOString(),
    updated_at: tenant.updatedAt.toISOString(),
    purged_at: tenant.purgedAt?.toISOString() ?? null,
  };
}

export interface DirectoryEntry {
  tenant_id: string;
  cell_id: string;
  data_region: string;
  isolation_tier: IsolationTier;
  status: TenantStatus;
}

export interface TenantPage {
  items: TenantView[];
  next_cursor: string | null;
}
