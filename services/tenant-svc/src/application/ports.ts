import { type TenantStatus } from '@atlas/contracts';
import { type Tx } from '@atlas/platform';
import { type CellTopology } from '../domain/cell-placement';
import { type DataKey, type StatusChange, type Tenant } from '../domain/tenant';

export interface TenantListFilter {
  status?: TenantStatus;
  dataRegion?: string;
  limit: number;
  /** Keyset cursor: the last row of the previous page. */
  after?: { createdAt: Date; id: string };
}

/** Persistence port. Every method runs inside a transaction owned by the application layer. */
export interface TenantRepository {
  insert(tx: Tx, tenant: Tenant): Promise<void>;
  findById(tx: Tx, id: string, options?: { forUpdate?: boolean }): Promise<Tenant | null>;
  findBySlug(tx: Tx, slug: string): Promise<Tenant | null>;
  list(tx: Tx, filter: TenantListFilter): Promise<Tenant[]>;
  /** Compare-and-set on `version`; returns false if another writer got there first. */
  update(tx: Tx, tenant: Tenant, expectedVersion: number): Promise<boolean>;
  appendHistory(tx: Tx, change: StatusChange): Promise<void>;
  /** Adds a key version to the tenant's key ring. */
  insertDataKey(tx: Tx, key: DataKey): Promise<void>;
  /** Stops a key version being used for new writes; it still decrypts. */
  retireDataKey(tx: Tx, tenantId: string, version: number, at: Date): Promise<void>;
  /** Crypto-shredding: nulls every wrapped key version. Returns how many were destroyed. */
  destroyDataKeys(tx: Tx, tenantId: string, at: Date): Promise<number>;
  /** Every version not yet destroyed, newest first. */
  listDataKeys(tx: Tx, tenantId: string): Promise<StoredDataKey[]>;
}

/** Envelope-encryption port (PRD §4.2). Returns only the wrapped key; plaintext never leaves the KMS boundary. */
export interface KeyManagementPort {
  generateDataKey(kmsKeyRef: string): Promise<{ wrappedKey: Uint8Array }>;
}

export interface StoredDataKey {
  version: number;
  kmsKeyRef: string;
  wrappedKey: Uint8Array;
  retiredAt: Date | null;
}

export interface TenantServiceSettings {
  cells: CellTopology;
  kmsKeyRef: string;
  purgeGraceDays: number;
}

export const TENANT_REPOSITORY = Symbol('TENANT_REPOSITORY');
export const KEY_MANAGEMENT = Symbol('KEY_MANAGEMENT');
export const TENANT_SERVICE_SETTINGS = Symbol('TENANT_SERVICE_SETTINGS');
