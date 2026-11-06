import { ROLES, type Role } from '@atlas/contracts';
import { z } from 'zod';

/** The authenticated caller, derived only from a verified token (§4.3). */
export interface Principal {
  subject: string;
  /** Null for platform staff (super_admin) and platform-level service principals. */
  tenantId: string | null;
  roles: readonly Role[];
  scopes: readonly string[];
}

export const tokenClaimsSchema = z.object({
  sub: z.string().min(1),
  tid: z.string().uuid().nullable().optional(),
  roles: z.array(z.enum(ROLES)).min(1),
  scopes: z.array(z.string()).default([]),
});

export function hasAnyRole(principal: Principal, roles: readonly Role[]): boolean {
  return roles.some((role) => principal.roles.includes(role));
}

export function isSuperAdmin(principal: Principal): boolean {
  return principal.roles.includes('super_admin');
}

/** True when the caller may act on `tenantId`: platform staff, or a member of that tenant. */
export function canAccessTenant(principal: Principal, tenantId: string): boolean {
  return isSuperAdmin(principal) || principal.tenantId === tenantId;
}
