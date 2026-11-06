import { describe, expect, it } from 'vitest';
import {
  assertSupportedRegion,
  fnv1a,
  placeTenant,
  type CellTopology,
} from '../../src/domain/cell-placement';
import { TenantDomainError } from '../../src/domain/errors';
import {
  assertMayChangeSettings,
  assertSettingsInvariants,
  changedKeys,
  DEFAULT_SETTINGS,
} from '../../src/domain/settings';
import { assertValidSlug } from '../../src/domain/slug';
import {
  applyLifecycle,
  assertVersion,
  createTenant,
  PURGED_DISPLAY_NAME,
  rename,
  replaceRetentionPolicy,
  replaceSettings,
  rotateDataKey,
  shredsDataKeys,
  type Tenant,
  TRANSITIONS,
} from '../../src/domain/tenant';

const NOW = new Date('2026-11-01T10:00:00.000Z');
const DAY = 86_400_000;
const opts = (over: Partial<Parameters<typeof applyLifecycle>[2]> = {}) => ({
  actor: 'admin-1',
  now: NOW,
  purgeGraceDays: 30,
  ...over,
});

function newTenant(): Tenant {
  return createNew().tenant;
}

function createNew(): ReturnType<typeof createTenant> {
  return createTenant({
    id: '0192f0c4-0000-7000-8000-000000000001',
    slug: 'acme-corp',
    displayName: '  Acme Corp ',
    isolationTier: 'pooled',
    dataRegion: 'eu-central-1',
    cellId: 'eu-pool-01',
    kmsKeyRef: 'local:dev',
    wrappedDek: new Uint8Array([1, 2, 3]),
    actor: 'admin-1',
    now: NOW,
  });
}

function expectDomainError(fn: () => unknown, code: string, kind?: string): void {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(TenantDomainError);
    expect((error as TenantDomainError).code).toBe(code);
    if (kind) expect((error as TenantDomainError).kind).toBe(kind);
    return;
  }
  throw new Error(`expected ${code}`);
}

describe('slug rules', () => {
  it.each(['abc', 'acme-corp', 'a1b2', 'x'.repeat(63)])('accepts %s', (slug) => {
    expect(assertValidSlug(slug)).toBe(slug);
  });

  it.each(['ab', 'Acme', '-acme', 'acme-', 'ac--me', 'acme_corp', 'x'.repeat(64), 'acmé'])(
    'rejects %s',
    (slug) => {
      expectDomainError(() => assertValidSlug(slug), 'TENANT_SLUG_INVALID', 'validation');
    },
  );

  it('rejects reserved platform subdomains', () => {
    expectDomainError(() => assertValidSlug('admin'), 'TENANT_SLUG_RESERVED', 'rule');
  });
});

describe('cell placement', () => {
  const topology: CellTopology = {
    'eu-central-1': { pooled: ['eu-pool-01', 'eu-pool-02', 'eu-pool-03'] },
  };

  it('is deterministic for a tenant id', () => {
    const input = {
      tenantId: 'tenant-a',
      slug: 'acme',
      region: 'eu-central-1',
      tier: 'pooled' as const,
    };
    expect(placeTenant(topology, input)).toBe(placeTenant(topology, input));
  });

  it('spreads tenants across pooled cells', () => {
    const cells = new Set(
      Array.from({ length: 60 }, (_, i) =>
        placeTenant(topology, {
          tenantId: `t-${i}`,
          slug: 's',
          region: 'eu-central-1',
          tier: 'pooled',
        }),
      ),
    );
    expect(cells.size).toBe(3);
  });

  it('gives dedicated tenants their own cell', () => {
    expect(
      placeTenant(topology, {
        tenantId: 't',
        slug: 'bank-x',
        region: 'eu-central-1',
        tier: 'dedicated',
      }),
    ).toBe('eu-central-1-dedicated-bank-x');
  });

  it('rejects unsupported regions', () => {
    expectDomainError(
      () => assertSupportedRegion(topology, 'us-east-1'),
      'UNSUPPORTED_DATA_REGION',
      'rule',
    );
  });

  it('uses a stable FNV-1a hash', () => {
    expect(fnv1a('')).toBe(0x811c9dc5);
    expect(fnv1a('a')).toBe(0xe40c292c);
  });
});

describe('settings invariants', () => {
  it('accepts defaults', () => {
    expect(assertSettingsInvariants(DEFAULT_SETTINGS)).toBe(DEFAULT_SETTINGS);
  });

  it('requires matching weights to sum to 1', () => {
    const settings = {
      ...DEFAULT_SETTINGS,
      matching: { weights: { sem: 0.4, cov: 0.3, exp: 0.1, lex: 0.1 } },
    };
    expectDomainError(() => assertSettingsInvariants(settings), 'INVALID_SETTINGS', 'validation');
  });

  it('tolerates floating-point rounding', () => {
    const settings = {
      ...DEFAULT_SETTINGS,
      matching: { weights: { sem: 0.1, cov: 0.2, exp: 0.3, lex: 0.4 } },
    };
    expect(() => assertSettingsInvariants(settings)).not.toThrow();
  });

  it('requires namespaced feature flags', () => {
    expectDomainError(
      () => assertSettingsInvariants({ ...DEFAULT_SETTINGS, features: { betaThing: true } }),
      'INVALID_SETTINGS',
    );
  });

  it('reports changed top-level keys', () => {
    expect(changedKeys(DEFAULT_SETTINGS, { ...DEFAULT_SETTINGS, locale: 'ar' })).toEqual([
      'locale',
    ]);
  });

  it('ignores key order when comparing', () => {
    const before = { ...DEFAULT_SETTINGS, features: { 'a.b.c': true, 'x.y.z': false } };
    const after = { ...DEFAULT_SETTINGS, features: { 'x.y.z': false, 'a.b.c': true } };
    expect(changedKeys(before, after)).toEqual([]);
  });

  it('lets only platform staff change limits and features', () => {
    const moreRps = { ...DEFAULT_SETTINGS, limits: { ...DEFAULT_SETTINGS.limits, api_rps: 9999 } };
    const newFeature = { ...DEFAULT_SETTINGS, features: { 'interview.ai.enabled': true } };
    expectDomainError(
      () => assertMayChangeSettings(DEFAULT_SETTINGS, moreRps, false),
      'PLATFORM_MANAGED_SETTING',
      'forbidden',
    );
    expectDomainError(
      () => assertMayChangeSettings(DEFAULT_SETTINGS, newFeature, false),
      'PLATFORM_MANAGED_SETTING',
    );
    expect(() => assertMayChangeSettings(DEFAULT_SETTINGS, moreRps, true)).not.toThrow();
    // Tenant admins can still change everything else, and resend platform sections unchanged.
    expect(() =>
      assertMayChangeSettings(DEFAULT_SETTINGS, { ...DEFAULT_SETTINGS, locale: 'ar' }, false),
    ).not.toThrow();
  });
});

describe('tenant lifecycle', () => {
  it('starts in provisioning with version 1 and trimmed name', () => {
    const t = newTenant();
    expect(t).toMatchObject({
      status: 'provisioning',
      version: 1,
      dekVersion: 1,
      displayName: 'Acme Corp',
    });
  });

  it('walks the full happy path and bumps the version each time', () => {
    let t = newTenant();
    t = applyLifecycle(t, 'activate', opts()).tenant;
    t = applyLifecycle(t, 'suspend', opts({ reason: 'unpaid invoice' })).tenant;
    t = applyLifecycle(t, 'reactivate', opts()).tenant;
    const offboard = applyLifecycle(t, 'offboard', opts({ reason: 'contract ended' }));
    expect(offboard.tenant.purgeNotBefore?.toISOString()).toBe(
      new Date(NOW.getTime() + 30 * DAY).toISOString(),
    );
    const purged = applyLifecycle(
      offboard.tenant,
      'purge',
      opts({ now: new Date(NOW.getTime() + 30 * DAY) }),
    ).tenant;
    expect(purged).toMatchObject({
      status: 'purged',
      displayName: PURGED_DISPLAY_NAME,
      version: 6,
    });
    expect(purged.purgedAt).not.toBeNull();
    expect(shredsDataKeys(purged)).toBe(true);
    expect(shredsDataKeys(offboard.tenant)).toBe(false);
  });

  it('starts the key ring at version 1 on create', () => {
    const { tenant, dataKey } = createNew();
    expect(tenant.dekVersion).toBe(1);
    expect(dataKey).toEqual({
      tenantId: tenant.id,
      version: 1,
      kmsKeyRef: 'local:dev',
      wrappedKey: new Uint8Array([1, 2, 3]),
      createdAt: NOW,
    });
  });

  it('records who changed what and why', () => {
    const active = applyLifecycle(newTenant(), 'activate', opts()).tenant;
    const { change } = applyLifecycle(active, 'suspend', opts({ reason: '  fraud review ' }));
    expect(change).toEqual({
      tenantId: active.id,
      from: 'active',
      to: 'suspended',
      reason: 'fraud review',
      actor: 'admin-1',
      occurredAt: NOW,
    });
  });

  it.each([
    ['activate', 'active'],
    ['reactivate', 'provisioning'],
    ['purge', 'active'],
    ['suspend', 'provisioning'],
  ] as const)('rejects %s from %s', (action, status) => {
    const tenant = { ...newTenant(), status };
    expectDomainError(
      () => applyLifecycle(tenant, action, opts({ reason: 'r' })),
      'INVALID_TENANT_TRANSITION',
      'rule',
    );
  });

  it('requires a reason to suspend or offboard', () => {
    const active = applyLifecycle(newTenant(), 'activate', opts()).tenant;
    expectDomainError(
      () => applyLifecycle(active, 'suspend', opts()),
      'REASON_REQUIRED',
      'validation',
    );
    expectDomainError(
      () => applyLifecycle(active, 'offboard', opts({ reason: '   ' })),
      'REASON_REQUIRED',
    );
  });

  it('blocks purge during the grace period', () => {
    const active = applyLifecycle(newTenant(), 'activate', opts()).tenant;
    const offboarding = applyLifecycle(active, 'offboard', opts({ reason: 'bye' })).tenant;
    expectDomainError(
      () => applyLifecycle(offboarding, 'purge', opts({ now: new Date(NOW.getTime() + 29 * DAY) })),
      'PURGE_GRACE_PERIOD_ACTIVE',
    );
  });

  it('rejects a non-positive grace period', () => {
    const active = applyLifecycle(newTenant(), 'activate', opts()).tenant;
    expectDomainError(
      () => applyLifecycle(active, 'offboard', opts({ reason: 'x', purgeGraceDays: 0 })),
      'INVALID_GRACE_PERIOD',
    );
  });

  it('exposes exactly the documented transitions', () => {
    expect(
      Object.fromEntries(Object.entries(TRANSITIONS).map(([k, v]) => [k, [v.from, v.to]])),
    ).toEqual({
      activate: [['provisioning'], 'active'],
      suspend: [['active'], 'suspended'],
      reactivate: [['suspended'], 'active'],
      offboard: [['active', 'suspended'], 'offboarding'],
      purge: [['offboarding'], 'purged'],
    });
  });
});

describe('mutations', () => {
  const purged = (): Tenant => ({ ...newTenant(), status: 'purged' });

  it('renames with validation', () => {
    expect(rename(newTenant(), 'New Name', NOW)).toMatchObject({
      displayName: 'New Name',
      version: 2,
    });
    expectDomainError(() => rename(newTenant(), '   ', NOW), 'INVALID_DISPLAY_NAME');
    expectDomainError(() => rename(purged(), 'x', NOW), 'TENANT_PURGED');
  });

  it('replaces settings and retention unless purged', () => {
    expect(
      replaceSettings(newTenant(), { ...DEFAULT_SETTINGS, locale: 'ar' }, NOW).settings.locale,
    ).toBe('ar');
    expectDomainError(() => replaceSettings(purged(), DEFAULT_SETTINGS, NOW), 'TENANT_PURGED');
    const policy = { ...newTenant().retentionPolicy, proctoring_frames_days: 7 };
    expect(
      replaceRetentionPolicy(newTenant(), policy, NOW).retentionPolicy.proctoring_frames_days,
    ).toBe(7);
    expectDomainError(() => replaceRetentionPolicy(purged(), policy, NOW), 'TENANT_PURGED');
  });

  it('rotates the data key only for active tenants', () => {
    const active = applyLifecycle(newTenant(), 'activate', opts()).tenant;
    const rotated = rotateDataKey(active, new Uint8Array([9]), NOW);
    expect(rotated.tenant).toMatchObject({ dekVersion: 2, version: 3 });
    expect(rotated.retiredVersion).toBe(1);
    expect(rotated.dataKey).toMatchObject({ version: 2, kmsKeyRef: 'local:dev' });
    expectDomainError(
      () => rotateDataKey(newTenant(), new Uint8Array([9]), NOW),
      'TENANT_NOT_ACTIVE',
    );
  });

  it('detects stale versions', () => {
    expectDomainError(
      () => assertVersion(newTenant(), 2),
      'VERSION_MISMATCH',
      'precondition_failed',
    );
    expect(() => assertVersion(newTenant(), 1)).not.toThrow();
  });
});
