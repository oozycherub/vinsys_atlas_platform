import { type Role } from '@atlas/contracts';
import {
  type AppError,
  BadRequestError,
  ConflictError,
  DomainRuleError,
  ForbiddenError,
  hasAnyRole,
  isSuperAdmin,
  isUuid,
  NotFoundError,
  PreconditionFailedError,
  type Principal,
} from '@atlas/platform';
import { ProfileDomainError } from '../domain/errors';
import { type EvidenceActor } from '../domain/evidence';

/** Roles that see every candidate of their tenant. Employees and candidates see only themselves. */
export const STAFF_ROLES: Role[] = [
  'tenant_admin',
  'recruiter',
  'hiring_manager',
  'reviewer',
  'sme',
];
/** Roles whose members may read decrypted PII (`pii:read`). Reviewers and SMEs review blind. */
export const PII_ROLES: Role[] = ['tenant_admin', 'recruiter', 'hiring_manager'];
export const MANAGER_ROLES: Role[] = ['tenant_admin', 'hiring_manager'];

/**
 * The tenant a call acts on. Tenant users act on their own (another id → 404). Platform-wide
 * service principals and staff must name it.
 */
export function tenantOf(principal: Principal, requested: string | undefined): string {
  if (principal.tenantId) {
    if (requested !== undefined && requested !== principal.tenantId)
      throw new NotFoundError('NOT_FOUND', 'Not found.');
    return principal.tenantId;
  }
  if (isSuperAdmin(principal) || hasAnyRole(principal, ['service'])) {
    if (!requested || !isUuid(requested)) {
      throw new BadRequestError('TENANT_ID_REQUIRED', 'Platform principals must pass tenant_id.');
    }
    return requested;
  }
  throw new ForbiddenError('This token is not bound to a tenant.');
}

export function isSelf(principal: Principal, candidate: { userId: string | null }): boolean {
  return candidate.userId !== null && candidate.userId === principal.subject;
}

/** Staff and service principals see any candidate of the tenant; others only their own profile. */
export function canSee(principal: Principal, candidate: { userId: string | null }): boolean {
  return (
    hasAnyRole(principal, [...STAFF_ROLES, 'service', 'super_admin']) ||
    isSelf(principal, candidate)
  );
}

export function canReadPii(principal: Principal, candidate: { userId: string | null }): boolean {
  return (
    hasAnyRole(principal, PII_ROLES) ||
    (hasAnyRole(principal, ['service']) && principal.scopes.includes('pii:read')) ||
    isSelf(principal, candidate)
  );
}

export function evidenceActor(
  principal: Principal,
  candidate: { userId: string | null },
): EvidenceActor {
  if (hasAnyRole(principal, ['service'])) return 'system';
  if (isSelf(principal, candidate)) return 'self';
  if (hasAnyRole(principal, MANAGER_ROLES)) return 'manager';
  throw new ForbiddenError(
    'Only the person, their managers or a service can record skill evidence.',
  );
}

export function toAppError(error: ProfileDomainError): AppError {
  switch (error.kind) {
    case 'validation':
      return new BadRequestError(error.code, error.message);
    case 'forbidden':
      return new ForbiddenError(error.message, error.code);
    case 'not_found':
      return new NotFoundError(error.code, error.message);
    case 'conflict':
      return new ConflictError(error.code, error.message);
    case 'rule':
      return new DomainRuleError(error.code, error.message);
    case 'precondition_failed':
      return new PreconditionFailedError(error.code, error.message);
  }
}

export async function translate<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    if (error instanceof ProfileDomainError) throw toAppError(error);
    throw error;
  }
}
