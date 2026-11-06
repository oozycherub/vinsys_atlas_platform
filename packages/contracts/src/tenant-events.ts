import { z } from 'zod';
import { defineEvent } from './event';

/** Shared enums for the tenant directory (PRD §1.2.1, §1.2.4). */
export const TENANT_STATUSES = [
  'provisioning',
  'active',
  'suspended',
  'offboarding',
  'purged',
] as const;
export type TenantStatus = (typeof TENANT_STATUSES)[number];

export const ISOLATION_TIERS = ['pooled', 'dedicated'] as const;
export type IsolationTier = (typeof ISOLATION_TIERS)[number];

const uuid = z.string().uuid();
const isoTime = z.string().datetime({ offset: true });

const tenantRef = {
  tenant_id: uuid,
  slug: z.string(),
  cell_id: z.string(),
  data_region: z.string(),
  isolation_tier: z.enum(ISOLATION_TIERS),
};

const statusChange = {
  tenant_id: uuid,
  from_status: z.enum(TENANT_STATUSES),
  to_status: z.enum(TENANT_STATUSES),
  reason: z.string().nullable(),
  actor: z.string(),
  occurred_at: isoTime,
};

export const TenantProvisioned = defineEvent(
  'tenant.tenant.provisioned.v1',
  'tenant',
  z.object({
    ...tenantRef,
    display_name: z.string(),
    /** When set, identity-svc invites this address as the tenant's first tenant_admin. */
    bootstrap_admin_email: z.string().email().optional(),
    occurred_at: isoTime,
  }),
);

export const TenantActivated = defineEvent(
  'tenant.tenant.activated.v1',
  'tenant',
  z.object(statusChange),
);
export const TenantSuspended = defineEvent(
  'tenant.tenant.suspended.v1',
  'tenant',
  z.object(statusChange),
);
export const TenantReactivated = defineEvent(
  'tenant.tenant.reactivated.v1',
  'tenant',
  z.object(statusChange),
);
export const TenantOffboardingStarted = defineEvent(
  'tenant.tenant.offboarding_started.v1',
  'tenant',
  z.object({ ...statusChange, purge_not_before: isoTime }),
);
/** Consumers must delete every row and object for the tenant; the data key is already destroyed. */
export const TenantPurged = defineEvent(
  'tenant.tenant.purged.v1',
  'tenant',
  z.object(statusChange),
);

export const TenantSettingsUpdated = defineEvent(
  'tenant.tenant.settings_updated.v1',
  'tenant',
  z.object({
    tenant_id: uuid,
    version: z.number().int().positive(),
    changed_keys: z.array(z.string()),
    actor: z.string(),
    occurred_at: isoTime,
  }),
);

export const TenantDataKeyRotated = defineEvent(
  'tenant.tenant.data_key_rotated.v1',
  'tenant',
  z.object({
    tenant_id: uuid,
    dek_version: z.number().int().positive(),
    actor: z.string(),
    occurred_at: isoTime,
  }),
);
