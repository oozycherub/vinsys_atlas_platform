import { type IsolationTier, type TenantStatus } from '@atlas/contracts';
import { TenantDomainError } from './errors';
import {
  assertSettingsInvariants,
  DEFAULT_RETENTION,
  DEFAULT_SETTINGS,
  type RetentionPolicy,
  type TenantSettings,
} from './settings';
import { assertValidSlug } from './slug';

/** The tenant directory entry. Immutable: every operation returns a new value with version + 1. */
export interface Tenant {
  readonly id: string;
  readonly slug: string;
  readonly displayName: string;
  readonly isolationTier: IsolationTier;
  readonly status: TenantStatus;
  readonly cellId: string;
  readonly dataRegion: string;
  readonly kmsKeyRef: string;
  /** Version of the active data key in the key ring (`tenant_data_keys`). */
  readonly dekVersion: number;
  readonly settings: TenantSettings;
  readonly retentionPolicy: RetentionPolicy;
  readonly purgeNotBefore: Date | null;
  readonly version: number;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly purgedAt: Date | null;
}

/**
 * One version of a tenant's data encryption key, wrapped by the KMS key. Never the plaintext key.
 * Old versions stay in the ring after rotation so existing ciphertext can still be decrypted.
 */
export interface DataKey {
  readonly tenantId: string;
  readonly version: number;
  readonly kmsKeyRef: string;
  readonly wrappedKey: Uint8Array;
  readonly createdAt: Date;
}

export interface StatusChange {
  tenantId: string;
  from: TenantStatus | null;
  to: TenantStatus;
  reason: string | null;
  actor: string;
  occurredAt: Date;
}

export const LIFECYCLE_ACTIONS = [
  'activate',
  'suspend',
  'reactivate',
  'offboard',
  'purge',
] as const;
export type LifecycleAction = (typeof LIFECYCLE_ACTIONS)[number];

interface TransitionRule {
  from: readonly TenantStatus[];
  to: TenantStatus;
  requiresReason: boolean;
}

/** The only legal moves (docs/prompts/01-tenant-svc.md §6). */
export const TRANSITIONS: Readonly<Record<LifecycleAction, TransitionRule>> = {
  activate: { from: ['provisioning'], to: 'active', requiresReason: false },
  suspend: { from: ['active'], to: 'suspended', requiresReason: true },
  reactivate: { from: ['suspended'], to: 'active', requiresReason: false },
  offboard: { from: ['active', 'suspended'], to: 'offboarding', requiresReason: true },
  purge: { from: ['offboarding'], to: 'purged', requiresReason: false },
};

const DAY_MS = 24 * 60 * 60 * 1000;
export const PURGED_DISPLAY_NAME = '[purged]';

export interface NewTenantInput {
  id: string;
  slug: string;
  displayName: string;
  isolationTier: IsolationTier;
  dataRegion: string;
  cellId: string;
  kmsKeyRef: string;
  wrappedDek: Uint8Array;
  actor: string;
  now: Date;
}

export function createTenant(input: NewTenantInput): {
  tenant: Tenant;
  change: StatusChange;
  dataKey: DataKey;
} {
  const tenant: Tenant = {
    id: input.id,
    slug: assertValidSlug(input.slug),
    displayName: assertDisplayName(input.displayName),
    isolationTier: input.isolationTier,
    status: 'provisioning',
    cellId: input.cellId,
    dataRegion: input.dataRegion,
    kmsKeyRef: input.kmsKeyRef,
    dekVersion: 1,
    settings: DEFAULT_SETTINGS,
    retentionPolicy: DEFAULT_RETENTION,
    purgeNotBefore: null,
    version: 1,
    createdAt: input.now,
    updatedAt: input.now,
    purgedAt: null,
  };
  return {
    tenant,
    change: {
      tenantId: input.id,
      from: null,
      to: 'provisioning',
      reason: null,
      actor: input.actor,
      occurredAt: input.now,
    },
    dataKey: {
      tenantId: input.id,
      version: 1,
      kmsKeyRef: input.kmsKeyRef,
      wrappedKey: input.wrappedDek,
      createdAt: input.now,
    },
  };
}

export interface TransitionOptions {
  actor: string;
  now: Date;
  reason?: string | null;
  /** Days between offboarding and the earliest permitted purge. */
  purgeGraceDays: number;
}

export function applyLifecycle(
  tenant: Tenant,
  action: LifecycleAction,
  options: TransitionOptions,
): { tenant: Tenant; change: StatusChange } {
  const rule = TRANSITIONS[action];
  if (!rule.from.includes(tenant.status)) {
    throw new TenantDomainError(
      'rule',
      'INVALID_TENANT_TRANSITION',
      `Cannot ${action} a tenant that is ${tenant.status}; allowed from: ${rule.from.join(', ')}.`,
    );
  }
  const reason = options.reason?.trim() || null;
  if (rule.requiresReason && !reason) {
    throw new TenantDomainError(
      'validation',
      'REASON_REQUIRED',
      `A reason is required to ${action} a tenant.`,
    );
  }

  let next: Tenant = {
    ...tenant,
    status: rule.to,
    version: tenant.version + 1,
    updatedAt: options.now,
  };
  if (action === 'offboard') {
    if (!Number.isInteger(options.purgeGraceDays) || options.purgeGraceDays < 1) {
      throw new TenantDomainError(
        'rule',
        'INVALID_GRACE_PERIOD',
        'The purge grace period must be at least 1 day.',
      );
    }
    next = {
      ...next,
      purgeNotBefore: new Date(options.now.getTime() + options.purgeGraceDays * DAY_MS),
    };
  }
  if (action === 'purge') {
    if (tenant.purgeNotBefore && options.now.getTime() < tenant.purgeNotBefore.getTime()) {
      throw new TenantDomainError(
        'rule',
        'PURGE_GRACE_PERIOD_ACTIVE',
        `This tenant cannot be purged before ${tenant.purgeNotBefore.toISOString()}.`,
      );
    }
    // Crypto-shredding happens in the key ring: the application destroys every key version in the
    // same transaction (see shredsDataKeys). Without them, every ciphertext of this tenant is unreadable.
    next = {
      ...next,
      displayName: PURGED_DISPLAY_NAME,
      settings: DEFAULT_SETTINGS,
      purgedAt: options.now,
    };
  }
  return {
    tenant: next,
    change: {
      tenantId: tenant.id,
      from: tenant.status,
      to: rule.to,
      reason,
      actor: options.actor,
      occurredAt: options.now,
    },
  };
}

export function assertVersion(tenant: Tenant, expectedVersion: number): void {
  if (tenant.version !== expectedVersion) {
    throw new TenantDomainError(
      'precondition_failed',
      'VERSION_MISMATCH',
      `The tenant changed since you read it (current version ${tenant.version}). Re-read and retry.`,
    );
  }
}

function assertNotPurged(tenant: Tenant): void {
  if (tenant.status === 'purged') {
    throw new TenantDomainError('rule', 'TENANT_PURGED', 'A purged tenant cannot be modified.');
  }
}

function assertDisplayName(name: string): string {
  const trimmed = name.trim();
  if (trimmed.length < 1 || trimmed.length > 200) {
    throw new TenantDomainError(
      'validation',
      'INVALID_DISPLAY_NAME',
      'Display name must be 1–200 characters.',
    );
  }
  return trimmed;
}

export function rename(tenant: Tenant, displayName: string, now: Date): Tenant {
  assertNotPurged(tenant);
  return {
    ...tenant,
    displayName: assertDisplayName(displayName),
    version: tenant.version + 1,
    updatedAt: now,
  };
}

export function replaceSettings(tenant: Tenant, settings: TenantSettings, now: Date): Tenant {
  assertNotPurged(tenant);
  return {
    ...tenant,
    settings: assertSettingsInvariants(settings),
    version: tenant.version + 1,
    updatedAt: now,
  };
}

export function replaceRetentionPolicy(tenant: Tenant, policy: RetentionPolicy, now: Date): Tenant {
  assertNotPurged(tenant);
  return { ...tenant, retentionPolicy: policy, version: tenant.version + 1, updatedAt: now };
}

/** Key rotation is only meaningful while the tenant is live. Checked before asking the KMS for a key. */
export function assertCanRotateDataKey(tenant: Tenant): void {
  if (tenant.status !== 'active') {
    throw new TenantDomainError(
      'rule',
      'TENANT_NOT_ACTIVE',
      'Data keys can only be rotated for active tenants.',
    );
  }
}

/**
 * Adds a new key version. The previous version is retired (no new writes) but KEPT, so data
 * encrypted with it stays readable until it is re-encrypted or the tenant is purged.
 */
export function rotateDataKey(
  tenant: Tenant,
  wrappedKey: Uint8Array,
  now: Date,
): { tenant: Tenant; dataKey: DataKey; retiredVersion: number } {
  assertCanRotateDataKey(tenant);
  const version = tenant.dekVersion + 1;
  return {
    tenant: { ...tenant, dekVersion: version, version: tenant.version + 1, updatedAt: now },
    dataKey: {
      tenantId: tenant.id,
      version,
      kmsKeyRef: tenant.kmsKeyRef,
      wrappedKey,
      createdAt: now,
    },
    retiredVersion: tenant.dekVersion,
  };
}

/** True when moving to this tenant state must destroy every data-key version. */
export function shredsDataKeys(tenant: Tenant): boolean {
  return tenant.status === 'purged';
}
