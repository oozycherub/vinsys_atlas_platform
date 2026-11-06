import { type Role, TENANT_ROLES, type TenantRole } from '@atlas/contracts';
import { normalizeEmail } from './email';
import { IdentityDomainError } from './errors';

export const USER_STATUSES = ['invited', 'active', 'deactivated'] as const;
export type UserStatus = (typeof USER_STATUSES)[number];

/** A tenant user. Immutable: every operation returns a new value with version + 1. */
export interface User {
  readonly id: string;
  readonly tenantId: string;
  readonly email: string;
  readonly displayName: string;
  readonly roles: readonly TenantRole[];
  readonly businessUnitIds: readonly string[];
  readonly status: UserStatus;
  readonly lastLoginAt: Date | null;
  readonly version: number;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

/** Who is acting. Platform staff (super_admin) may manage any tenant's users. */
export interface Actor {
  subject: string;
  roles: readonly Role[];
}

export const INVITATION_TTL_MS = 72 * 60 * 60 * 1000;

function assertDisplayName(name: string): string {
  const trimmed = name.trim();
  if (trimmed.length < 1 || trimmed.length > 200) {
    throw new IdentityDomainError(
      'validation',
      'INVALID_DISPLAY_NAME',
      'Display name must be 1–200 characters.',
    );
  }
  return trimmed;
}

function assertBusinessUnits(ids: readonly string[]): readonly string[] {
  if (ids.length > 100) {
    throw new IdentityDomainError(
      'validation',
      'TOO_MANY_BUSINESS_UNITS',
      'A user can belong to at most 100 business units.',
    );
  }
  return [...new Set(ids)].sort();
}

/**
 * Role-grant rules (docs/prompts/02-identity-svc.md §6):
 * - only tenant roles can be granted (never super_admin or service);
 * - granting tenant_admin needs tenant_admin or super_admin (the caller's guard already
 *   restricts user management to those two roles);
 * - nobody changes their own roles.
 */
export function assertGrantable(
  actor: Actor,
  requested: readonly string[],
  targetUserId: string | null,
): readonly TenantRole[] {
  if (requested.length === 0) {
    throw new IdentityDomainError('validation', 'ROLES_REQUIRED', 'At least one role is required.');
  }
  const notGrantable = requested.filter((r) => !(TENANT_ROLES as readonly string[]).includes(r));
  if (notGrantable.length > 0) {
    throw new IdentityDomainError(
      'forbidden',
      'ROLE_NOT_GRANTABLE',
      `These roles cannot be granted to tenant users: ${notGrantable.join(', ')}.`,
    );
  }
  if (targetUserId !== null && targetUserId === actor.subject) {
    throw new IdentityDomainError(
      'forbidden',
      'SELF_ROLE_CHANGE',
      'You cannot change your own roles.',
    );
  }
  return [...new Set(requested as TenantRole[])].sort();
}

export interface InviteInput {
  id: string;
  tenantId: string;
  email: string;
  displayName: string;
  roles: readonly string[];
  businessUnitIds?: readonly string[];
  actor: Actor;
  now: Date;
}

export function inviteUser(input: InviteInput): { user: User; expiresAt: Date } {
  const user: User = {
    id: input.id,
    tenantId: input.tenantId,
    email: normalizeEmail(input.email),
    displayName: assertDisplayName(input.displayName),
    roles: assertGrantable(input.actor, input.roles, null),
    businessUnitIds: assertBusinessUnits(input.businessUnitIds ?? []),
    status: 'invited',
    lastLoginAt: null,
    version: 1,
    createdAt: input.now,
    updatedAt: input.now,
  };
  return { user, expiresAt: new Date(input.now.getTime() + INVITATION_TTL_MS) };
}

/** Bootstrap invitation from tenant provisioning: the first tenant_admin. */
export function bootstrapAdmin(input: Omit<InviteInput, 'roles' | 'actor' | 'displayName'>): {
  user: User;
  expiresAt: Date;
} {
  return inviteUser({
    ...input,
    displayName: normalizeEmail(input.email).split('@')[0] ?? 'Administrator',
    roles: ['tenant_admin'],
    actor: { subject: 'tenant-svc', roles: ['service'] },
  });
}

export interface UserPatch {
  displayName?: string;
  roles?: readonly string[];
  businessUnitIds?: readonly string[];
}

export function patchUser(user: User, patch: UserPatch, actor: Actor, now: Date): User {
  if (user.status === 'deactivated') {
    throw new IdentityDomainError(
      'rule',
      'USER_DEACTIVATED',
      'A deactivated user cannot be modified.',
    );
  }
  return {
    ...user,
    ...(patch.displayName !== undefined
      ? { displayName: assertDisplayName(patch.displayName) }
      : {}),
    ...(patch.roles !== undefined ? { roles: assertGrantable(actor, patch.roles, user.id) } : {}),
    ...(patch.businessUnitIds !== undefined
      ? { businessUnitIds: assertBusinessUnits(patch.businessUnitIds) }
      : {}),
    version: user.version + 1,
    updatedAt: now,
  };
}

export function rolesChanged(before: User, after: User): boolean {
  return before.roles.join(',') !== after.roles.join(',');
}

export function activateUser(user: User, now: Date): User {
  if (user.status !== 'invited') {
    throw new IdentityDomainError(
      'unauthorized',
      'INVALID_LINK',
      'This invitation can no longer be used.',
    );
  }
  return { ...user, status: 'active', lastLoginAt: now, version: user.version + 1, updatedAt: now };
}

export function deactivateUser(user: User, actor: Actor, now: Date): User {
  if (user.id === actor.subject) {
    throw new IdentityDomainError(
      'forbidden',
      'SELF_DEACTIVATION',
      'You cannot deactivate yourself.',
    );
  }
  if (user.status === 'deactivated') {
    throw new IdentityDomainError('rule', 'USER_DEACTIVATED', 'The user is already deactivated.');
  }
  return { ...user, status: 'deactivated', version: user.version + 1, updatedAt: now };
}

export function recordLogin(user: User, now: Date): User {
  if (user.status !== 'active') {
    throw new IdentityDomainError(
      'unauthorized',
      'INVALID_LINK',
      'This link can no longer be used.',
    );
  }
  return { ...user, lastLoginAt: now, version: user.version + 1, updatedAt: now };
}

/** SSO enforcement applies to workforce users. Candidates (external people) keep magic links. */
export function requiresSso(user: User): boolean {
  return user.roles.some((role) => role !== 'candidate');
}

export function assertVersion(user: User, expected: number): void {
  if (user.version !== expected) {
    throw new IdentityDomainError(
      'precondition_failed',
      'VERSION_MISMATCH',
      `The user changed since you read it (current version ${user.version}). Re-read and retry.`,
    );
  }
}
