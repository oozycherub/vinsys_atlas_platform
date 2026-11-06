import { describe, expect, it } from 'vitest';
import { emailDomain, normalizeEmail } from '../../src/domain/email';
import { IdentityDomainError } from '../../src/domain/errors';
import {
  isRotationDue,
  planRotation,
  PREPUBLISH_MS,
  publishedKeys,
  ROTATION_INTERVAL_MS,
  selectSigningKey,
  type SigningKeyMeta,
} from '../../src/domain/signing-keys';
import {
  evaluateRefresh,
  formatRefreshToken,
  grantScopes,
  parseRefreshToken,
  type RefreshTokenRecord,
} from '../../src/domain/tokens';
import {
  activateUser,
  type Actor,
  assertGrantable,
  assertVersion,
  bootstrapAdmin,
  deactivateUser,
  INVITATION_TTL_MS,
  inviteUser,
  patchUser,
  recordLogin,
  requiresSso,
  rolesChanged,
  type User,
} from '../../src/domain/user';

const NOW = new Date('2026-11-01T10:00:00.000Z');
const TENANT = '0192f0c4-0000-7000-8000-000000000001';
const admin: Actor = { subject: 'admin-1', roles: ['tenant_admin'] };

function expectDomainError(fn: () => unknown, code: string, kind?: string): void {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(IdentityDomainError);
    expect((error as IdentityDomainError).code).toBe(code);
    if (kind) expect((error as IdentityDomainError).kind).toBe(kind);
    return;
  }
  throw new Error(`expected ${code}`);
}

function invited(roles: string[] = ['recruiter']): User {
  return inviteUser({
    id: 'user-1',
    tenantId: TENANT,
    email: '  Ada@Example.COM ',
    displayName: ' Ada ',
    roles,
    businessUnitIds: ['b', 'a', 'b'],
    actor: admin,
    now: NOW,
  }).user;
}

describe('email', () => {
  it('normalises and validates', () => {
    expect(normalizeEmail(' Ada@Example.COM ')).toBe('ada@example.com');
    expect(emailDomain('ada@example.com')).toBe('example.com');
    for (const bad of ['', 'no-at', 'a@b', `${'x'.repeat(250)}@a.com`]) {
      expectDomainError(() => normalizeEmail(bad), 'INVALID_EMAIL', 'validation');
    }
  });
});

describe('users', () => {
  it('invites with normalised fields and a 72 h link', () => {
    const { user, expiresAt } = inviteUser({
      id: 'u',
      tenantId: TENANT,
      email: 'X@Y.io',
      displayName: 'X',
      roles: ['sme', 'recruiter', 'sme'],
      actor: admin,
      now: NOW,
    });
    expect(user).toMatchObject({
      email: 'x@y.io',
      roles: ['recruiter', 'sme'],
      status: 'invited',
      version: 1,
    });
    expect(expiresAt.getTime() - NOW.getTime()).toBe(INVITATION_TTL_MS);
    expect(invited().businessUnitIds).toEqual(['a', 'b']);
  });

  it('never grants platform roles, nor lets users change their own roles', () => {
    expectDomainError(
      () => assertGrantable(admin, ['super_admin'], null),
      'ROLE_NOT_GRANTABLE',
      'forbidden',
    );
    expectDomainError(() => assertGrantable(admin, ['service'], null), 'ROLE_NOT_GRANTABLE');
    expectDomainError(() => assertGrantable(admin, [], null), 'ROLES_REQUIRED', 'validation');
    expectDomainError(() => assertGrantable(admin, ['recruiter'], 'admin-1'), 'SELF_ROLE_CHANGE');
    expect(assertGrantable(admin, ['employee', 'candidate'], 'other')).toEqual([
      'candidate',
      'employee',
    ]);
  });

  it('validates display names and business units', () => {
    expectDomainError(
      () =>
        inviteUser({
          id: 'u',
          tenantId: TENANT,
          email: 'a@b.co',
          displayName: ' ',
          roles: ['sme'],
          actor: admin,
          now: NOW,
        }),
      'INVALID_DISPLAY_NAME',
    );
    const many = Array.from({ length: 101 }, (_, i) => `bu-${i}`);
    expectDomainError(
      () => patchUser(invited(), { businessUnitIds: many }, admin, NOW),
      'TOO_MANY_BUSINESS_UNITS',
    );
  });

  it('bootstraps the first tenant admin', () => {
    const { user } = bootstrapAdmin({ id: 'u', tenantId: TENANT, email: 'Boss@Acme.io', now: NOW });
    expect(user).toMatchObject({
      roles: ['tenant_admin'],
      displayName: 'boss',
      email: 'boss@acme.io',
    });
  });

  it('patches, detects role changes and checks versions', () => {
    const before = invited();
    const after = patchUser(before, { roles: ['reviewer'], displayName: 'Ada L' }, admin, NOW);
    expect(after).toMatchObject({ roles: ['reviewer'], displayName: 'Ada L', version: 2 });
    expect(rolesChanged(before, after)).toBe(true);
    expect(rolesChanged(before, patchUser(before, { displayName: 'Z' }, admin, NOW))).toBe(false);
    expectDomainError(() => assertVersion(after, 1), 'VERSION_MISMATCH', 'precondition_failed');
    expect(() => assertVersion(after, 2)).not.toThrow();
  });

  it('moves through invited → active → deactivated', () => {
    const active = activateUser(invited(), NOW);
    expect(active).toMatchObject({ status: 'active', lastLoginAt: NOW });
    expectDomainError(() => activateUser(active, NOW), 'INVALID_LINK', 'unauthorized');
    expect(recordLogin(active, NOW).version).toBe(active.version + 1);
    expectDomainError(() => recordLogin(invited(), NOW), 'INVALID_LINK');

    expectDomainError(
      () => deactivateUser(active, { ...admin, subject: active.id }, NOW),
      'SELF_DEACTIVATION',
    );
    const gone = deactivateUser(active, admin, NOW);
    expect(gone.status).toBe('deactivated');
    expectDomainError(() => deactivateUser(gone, admin, NOW), 'USER_DEACTIVATED', 'rule');
    expectDomainError(() => patchUser(gone, { displayName: 'x' }, admin, NOW), 'USER_DEACTIVATED');
  });

  it('applies SSO enforcement to workforce users only', () => {
    expect(requiresSso(invited(['candidate']))).toBe(false);
    expect(requiresSso(invited(['candidate', 'employee']))).toBe(true);
  });
});

describe('refresh tokens', () => {
  const token: RefreshTokenRecord = {
    id: 't',
    tenantId: TENANT,
    userId: 'u',
    familyId: 'f',
    amr: ['email'],
    expiresAt: new Date(NOW.getTime() + 1000),
    usedAt: null,
    revokedAt: null,
  };

  it('rotates fresh tokens and flags reuse', () => {
    expect(evaluateRefresh(token, NOW)).toEqual({ kind: 'rotate' });
    expect(evaluateRefresh({ ...token, usedAt: NOW }, NOW)).toEqual({ kind: 'reuse' });
    expect(evaluateRefresh({ ...token, revokedAt: NOW, usedAt: NOW }, NOW)).toEqual({
      kind: 'invalid',
      reason: 'revoked',
    });
    expect(evaluateRefresh(token, new Date(NOW.getTime() + 1000))).toEqual({
      kind: 'invalid',
      reason: 'expired',
    });
  });

  it('embeds the tenant so lookups run under RLS', () => {
    const secret = 'A'.repeat(43);
    expect(parseRefreshToken(formatRefreshToken(TENANT, secret))).toEqual({ tenantId: TENANT });
    expectDomainError(
      () => parseRefreshToken(`rt.${TENANT}.short`),
      'INVALID_GRANT',
      'unauthorized',
    );
  });

  it('grants only allowed scopes', () => {
    expect(grantScopes(['b:x', 'a:y'], undefined)).toEqual(['a:y', 'b:x']);
    expect(grantScopes(['b:x', 'a:y'], 'a:y a:y')).toEqual(['a:y']);
    expectDomainError(() => grantScopes(['a:y'], 'a:y c:z'), 'INVALID_SCOPE', 'validation');
  });
});

describe('signing-key rotation', () => {
  const key = (
    kid: string,
    activatesAt: Date,
    retiresAt: Date | null = null,
    publishUntil: Date | null = null,
  ): SigningKeyMeta => ({
    kid,
    createdAt: activatesAt,
    activatesAt,
    retiresAt,
    publishUntil,
  });

  it('creates an immediately active key on first boot', () => {
    expect(isRotationDue([], NOW)).toBe(true);
    expect(planRotation([], NOW)).toEqual({ activatesAt: NOW, retire: null });
  });

  it('pre-publishes the successor and keeps the old key until its tokens expire', () => {
    const old = key('old', new Date(NOW.getTime() - ROTATION_INTERVAL_MS));
    expect(isRotationDue([old], NOW)).toBe(true);
    expect(isRotationDue([key('fresh', NOW)], NOW)).toBe(false);

    const plan = planRotation([old], NOW);
    expect(plan.activatesAt.getTime()).toBe(NOW.getTime() + PREPUBLISH_MS);
    expect(plan.retire?.retiresAt).toEqual(plan.activatesAt);
    expect(plan.retire!.publishUntil.getTime()).toBeGreaterThan(
      plan.activatesAt.getTime() + 600_000,
    );

    const retired = key('old', old.activatesAt, plan.retire!.retiresAt, plan.retire!.publishUntil);
    const next = key('new', plan.activatesAt);
    expect(selectSigningKey([retired, next], NOW)?.kid).toBe('old');
    expect(selectSigningKey([retired, next], plan.activatesAt)?.kid).toBe('new');
    expect(publishedKeys([retired, next], NOW).map((k) => k.kid)).toEqual(['old', 'new']);
    expect(publishedKeys([retired, next], plan.retire!.publishUntil).map((k) => k.kid)).toEqual([
      'new',
    ]);
    expect(selectSigningKey([], NOW)).toBeNull();
  });
});
