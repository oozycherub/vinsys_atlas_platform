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

/** HR administration and analytics. */
export const ADMINS: Role[] = ['tenant_admin', 'super_admin'];
/** Leaders who post opportunities, staff projects and read analytics. */
export const MANAGERS: Role[] = ['tenant_admin', 'hiring_manager', 'super_admin'];
/** Anyone in the tenant's workforce (the marketplace's own view). */
export const WORKFORCE: Role[] = ['employee', 'hiring_manager', 'tenant_admin', 'super_admin'];

export const HRBP_SCOPE = 'hrbp';
export const HRIS_SCOPE = 'hris:sync';

/** Tenant users act on their own tenant (another id: 404); platform principals must name it. */
export function tenantOf(p: Principal, requested: string | undefined): string {
  if (p.tenantId) {
    if (requested !== undefined && requested !== p.tenantId)
      throw new NotFoundError('NOT_FOUND', 'Not found.');
    return p.tenantId;
  }
  if (isSuperAdmin(p) || hasAnyRole(p, ['service'])) {
    if (!requested || !isUuid(requested))
      throw new BadRequestError('TENANT_ID_REQUIRED', 'Platform principals must pass tenant_id.');
    return requested;
  }
  throw new ForbiddenError('This token is not bound to a tenant.');
}

export function requireRole(p: Principal, roles: readonly Role[]): void {
  if (!hasAnyRole(p, roles)) throw new ForbiddenError('Your role cannot do this.');
}

/** HRIS sync: tenant admins, or the HRIS connector's service token (scope hris:sync). */
export function requireHris(p: Principal): void {
  if (hasAnyRole(p, ADMINS)) return;
  if (hasAnyRole(p, ['service']) && p.scopes.includes(HRIS_SCOPE)) return;
  throw new ForbiddenError('HRIS sync needs tenant_admin or the hris:sync scope.');
}

/**
 * Attrition data (PRD §2.5(vi) governance): HR staff holding the `hrbp` scope only. Managers
 * without it get 403; employees never, whatever their scopes.
 */
export function requireHrbp(p: Principal): void {
  // Staff roles only: an employee token is refused whatever scopes it carries.
  if (!hasAnyRole(p, MANAGERS) || !p.scopes.includes(HRBP_SCOPE))
    throw new ForbiddenError('Attrition data needs the hrbp scope.');
}

export const isManager = (p: Principal): boolean => hasAnyRole(p, MANAGERS);
