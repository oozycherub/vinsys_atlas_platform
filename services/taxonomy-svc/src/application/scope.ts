import {
  type Database,
  ForbiddenError,
  hasAnyRole,
  isSuperAdmin,
  isUuid,
  NotFoundError,
  type Principal,
  type Tx,
  withSystemTx,
  withTenantTx,
} from '@atlas/platform';

/** Which taxonomy a call acts on: a tenant's view, or the global taxonomy (tenantId null). */
export interface Scope {
  tenantId: string | null;
}

/**
 * Reads: tenant users see their own tenant's view (naming another tenant gives 404). Platform
 * staff and service principals read the global taxonomy, or a tenant's view when they name one.
 */
export function readScope(principal: Principal, requested: string | undefined): Scope {
  // Platform-wide principals may pick a tenant; tenant-bound service clients may not.
  const platformWide =
    isSuperAdmin(principal) || (hasAnyRole(principal, ['service']) && !principal.tenantId);
  if (platformWide) {
    if (requested !== undefined && !isUuid(requested))
      throw new NotFoundError('NOT_FOUND', 'Not found.');
    return { tenantId: requested ?? null };
  }
  if (!principal.tenantId) throw new ForbiddenError('This token is not bound to a tenant.');
  if (requested !== undefined && requested !== principal.tenantId) {
    throw new NotFoundError('NOT_FOUND', 'Not found.');
  }
  return { tenantId: principal.tenantId };
}

/**
 * Writes: a tenant_admin writes its own tenant's overlay; the super_admin curator writes the
 * global taxonomy, or a named tenant's overlay.
 */
export function writeScope(principal: Principal, requested: string | undefined): Scope {
  if (isSuperAdmin(principal)) {
    if (requested !== undefined && !isUuid(requested))
      throw new NotFoundError('NOT_FOUND', 'Not found.');
    return { tenantId: requested ?? null };
  }
  if (!principal.tenantId || !hasAnyRole(principal, ['tenant_admin'])) {
    throw new ForbiddenError('Only tenant admins and the platform curator change the taxonomy.');
  }
  if (requested !== undefined && requested !== principal.tenantId) {
    throw new NotFoundError('NOT_FOUND', 'Not found.');
  }
  return { tenantId: principal.tenantId };
}

/** Tenant scope → RLS-bound tenant transaction; global scope → system (curator) transaction. */
export function inScope<T>(db: Database, scope: Scope, work: (tx: Tx) => Promise<T>): Promise<T> {
  return scope.tenantId ? withTenantTx(db, scope.tenantId, work) : withSystemTx(db, work);
}

/** Job profiles exist only per tenant. */
export function tenantOnly(scope: Scope): string {
  if (!scope.tenantId) {
    throw new NotFoundError('TENANT_ID_REQUIRED', 'Job profiles are per tenant: pass tenant_id.');
  }
  return scope.tenantId;
}
