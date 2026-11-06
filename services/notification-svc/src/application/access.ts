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

export const ADMINS: Role[] = ['tenant_admin', 'super_admin'];
export const SEND_SCOPE = 'notifications:send';

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

/** The inbox belongs to a user of a tenant; platform principals have none. */
export function inboxOwner(p: Principal): { tenantId: string; userId: string } {
  if (!p.tenantId || hasAnyRole(p, ['service']))
    throw new ForbiddenError('Only tenant users have an inbox.');
  return { tenantId: p.tenantId, userId: p.subject };
}
