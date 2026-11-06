import { type Role } from '@atlas/contracts';
import {
  BadRequestError,
  ForbiddenError,
  hasAnyRole,
  isSuperAdmin,
  isUuid,
  NotFoundError,
  type Principal,
} from '@atlas/platform';

/** Who manages requisitions and runs matching. Candidates and employees never see scores. */
export const WRITERS: Role[] = [
  'tenant_admin',
  'recruiter',
  'hiring_manager',
  'super_admin',
  'service',
];
export const READERS: Role[] = [...WRITERS, 'reviewer'];

/**
 * The tenant a call acts on. Tenant users act on their own (another id → 404); platform staff
 * and services must name it.
 */
export function tenantOf(principal: Principal, requested: string | undefined): string {
  if (principal.tenantId) {
    if (requested !== undefined && requested !== principal.tenantId) {
      throw new NotFoundError('NOT_FOUND', 'Not found.');
    }
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
