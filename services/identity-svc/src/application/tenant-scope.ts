import {
  BadRequestError,
  ForbiddenError,
  isSuperAdmin,
  isUuid,
  NotFoundError,
  type Principal,
} from '@atlas/platform';
import { type Actor } from '../domain/user';

/**
 * Which tenant a management call acts on. Tenant users always act on their own tenant (naming
 * another one gives 404, so tenant ids cannot be probed); platform staff must name the tenant.
 */
export function actingTenant(principal: Principal, requested: string | undefined): string {
  if (isSuperAdmin(principal)) {
    if (!requested || !isUuid(requested)) {
      throw new BadRequestError('TENANT_ID_REQUIRED', 'Platform staff must pass tenant_id.');
    }
    return requested;
  }
  if (!principal.tenantId) throw new ForbiddenError('This token is not bound to a tenant.');
  if (requested !== undefined && requested !== principal.tenantId) {
    throw new NotFoundError('NOT_FOUND', 'Not found.');
  }
  return principal.tenantId;
}

export function actorOf(principal: Principal): Actor {
  return { subject: principal.subject, roles: principal.roles };
}
