/**
 * Platform roles carried in the JWT `roles` claim (PRD §1.2.6).
 * `service` is used by machine principals (e.g. the API gateway) together with `scopes`.
 */
export const ROLES = [
  'super_admin',
  'tenant_admin',
  'recruiter',
  'hiring_manager',
  'reviewer',
  'sme',
  'employee',
  'candidate',
  'service',
] as const;

export type Role = (typeof ROLES)[number];

/** Roles a tenant user can hold. `super_admin` (platform staff) and `service` (machines) cannot be granted to tenant users. */
export const TENANT_ROLES = [
  'tenant_admin',
  'recruiter',
  'hiring_manager',
  'reviewer',
  'sme',
  'employee',
  'candidate',
] as const satisfies readonly Role[];

export type TenantRole = (typeof TENANT_ROLES)[number];
