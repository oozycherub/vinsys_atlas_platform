import { isUuid } from '../ids';

export interface QueryResult<R> {
  rows: R[];
  rowCount: number;
}

/** Anything that can run a parameterised statement. */
export interface Queryable {
  query<R = Record<string, unknown>>(
    sql: string,
    params?: readonly unknown[],
  ): Promise<QueryResult<R>>;
}

/** A statement executor bound to one open transaction. */
export type Tx = Queryable;

/**
 * Connection-pool abstraction. Production uses node-postgres (PgDatabase); integration tests
 * use PGlite (ADR-0005). Both run every unit of work inside one transaction.
 */
export interface Database {
  transaction<T>(work: (tx: Tx) => Promise<T>): Promise<T>;
  ping(): Promise<void>;
  close(): Promise<void>;
}

export const DATABASE = Symbol('DATABASE');

export class TenantContextError extends Error {
  constructor(detail: string) {
    super(detail);
    this.name = 'TenantContextError';
  }
}

/**
 * Binds the transaction to one tenant. RLS policies read `app.tenant_id`; `is_local = true`
 * scopes the setting to this transaction, which is safe with PgBouncer transaction pooling.
 */
export async function setTenantContext(tx: Tx, tenantId: string): Promise<void> {
  if (!isUuid(tenantId)) throw new TenantContextError('Tenant id must be a UUID.');
  await tx.query(`SELECT set_config('app.tenant_id', $1, true)`, [tenantId]);
}

/** The only sanctioned way to touch tenant-owned tables (MASTER_ORCHESTRATION_PROMPT §4.3). */
export function withTenantTx<T>(
  db: Database,
  tenantId: string,
  work: (tx: Tx) => Promise<T>,
): Promise<T> {
  if (!isUuid(tenantId)) return Promise.reject(new TenantContextError('Tenant id must be a UUID.'));
  return db.transaction(async (tx) => {
    await setTenantContext(tx, tenantId);
    return work(tx);
  });
}

/**
 * For platform-level work that is not scoped to one tenant (the tenant directory, idempotency
 * records, platform-wide events). Marks the transaction with `app.system = 'on'`.
 */
export function withSystemTx<T>(db: Database, work: (tx: Tx) => Promise<T>): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.query(`SELECT set_config('app.system', 'on', true)`);
    return work(tx);
  });
}
