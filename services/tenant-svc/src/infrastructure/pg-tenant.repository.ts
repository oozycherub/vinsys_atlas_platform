import { Injectable } from '@nestjs/common';
import { type IsolationTier, type TenantStatus } from '@atlas/contracts';
import { type Tx } from '@atlas/platform';
import {
  type StoredDataKey,
  type TenantListFilter,
  type TenantRepository,
} from '../application/ports';
import { TenantDomainError } from '../domain/errors';
import { type RetentionPolicy, type TenantSettings } from '../domain/settings';
import { type DataKey, type StatusChange, type Tenant } from '../domain/tenant';

interface TenantRow {
  tenant_id: string;
  slug: string;
  display_name: string;
  isolation_tier: IsolationTier;
  status: TenantStatus;
  cell_id: string;
  data_region: string;
  kms_key_ref: string;
  dek_version: number;
  settings: TenantSettings;
  retention_policy: RetentionPolicy;
  purge_not_before: Date | null;
  version: number;
  created_at: Date;
  updated_at: Date;
  purged_at: Date | null;
}

const COLUMNS = `tenant_id, slug, display_name, isolation_tier, status, cell_id, data_region, kms_key_ref,
  dek_version, settings, retention_policy, purge_not_before, version, created_at, updated_at, purged_at`;

const UNIQUE_VIOLATION = '23505';

function toTenant(row: TenantRow): Tenant {
  return {
    id: row.tenant_id,
    slug: row.slug,
    displayName: row.display_name,
    isolationTier: row.isolation_tier,
    status: row.status,
    cellId: row.cell_id,
    dataRegion: row.data_region,
    kmsKeyRef: row.kms_key_ref,
    dekVersion: Number(row.dek_version),
    settings: row.settings,
    retentionPolicy: row.retention_policy,
    purgeNotBefore: row.purge_not_before ? new Date(row.purge_not_before) : null,
    version: Number(row.version),
    createdAt: new Date(row.created_at),
    updatedAt: new Date(row.updated_at),
    purgedAt: row.purged_at ? new Date(row.purged_at) : null,
  };
}

/** SQL-first repository over `tenants` and `tenant_status_history` (ADR-0004). */
@Injectable()
export class PgTenantRepository implements TenantRepository {
  async insert(tx: Tx, t: Tenant): Promise<void> {
    try {
      await tx.query(
        `INSERT INTO tenants (tenant_id, slug, display_name, isolation_tier, status, cell_id, data_region, kms_key_ref,
           dek_version, settings, retention_policy, purge_not_before, version, created_at, updated_at, purged_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11::jsonb, $12, $13, $14, $15, $16)`,
        [
          t.id,
          t.slug,
          t.displayName,
          t.isolationTier,
          t.status,
          t.cellId,
          t.dataRegion,
          t.kmsKeyRef,
          t.dekVersion,
          JSON.stringify(t.settings),
          JSON.stringify(t.retentionPolicy),
          t.purgeNotBefore,
          t.version,
          t.createdAt,
          t.updatedAt,
          t.purgedAt,
        ],
      );
    } catch (error) {
      // A concurrent create with the same slug loses the race at the unique index.
      if ((error as { code?: string }).code === UNIQUE_VIOLATION) {
        throw new TenantDomainError(
          'conflict',
          'TENANT_SLUG_TAKEN',
          `The slug "${t.slug}" is already in use.`,
        );
      }
      throw error;
    }
  }

  async findById(
    tx: Tx,
    id: string,
    options: { forUpdate?: boolean } = {},
  ): Promise<Tenant | null> {
    const { rows } = await tx.query<TenantRow>(
      `SELECT ${COLUMNS} FROM tenants WHERE tenant_id = $1${options.forUpdate ? ' FOR UPDATE' : ''}`,
      [id],
    );
    return rows[0] ? toTenant(rows[0]) : null;
  }

  async findBySlug(tx: Tx, slug: string): Promise<Tenant | null> {
    const { rows } = await tx.query<TenantRow>(`SELECT ${COLUMNS} FROM tenants WHERE slug = $1`, [
      slug,
    ]);
    return rows[0] ? toTenant(rows[0]) : null;
  }

  async list(tx: Tx, filter: TenantListFilter): Promise<Tenant[]> {
    const { rows } = await tx.query<TenantRow>(
      `SELECT ${COLUMNS} FROM tenants
       WHERE ($1::tenant_status IS NULL OR status = $1::tenant_status)
         AND ($2::text IS NULL OR data_region = $2)
         AND ($3::timestamptz IS NULL OR (created_at, tenant_id) < ($3::timestamptz, $4::uuid))
       ORDER BY created_at DESC, tenant_id DESC
       LIMIT $5`,
      [
        filter.status ?? null,
        filter.dataRegion ?? null,
        filter.after?.createdAt ?? null,
        filter.after?.id ?? null,
        filter.limit,
      ],
    );
    return rows.map(toTenant);
  }

  async update(tx: Tx, t: Tenant, expectedVersion: number): Promise<boolean> {
    const { rowCount } = await tx.query(
      `UPDATE tenants SET display_name = $3, status = $4, dek_version = $5, settings = $6::jsonb,
         retention_policy = $7::jsonb, purge_not_before = $8, version = $9, purged_at = $10
       WHERE tenant_id = $1 AND version = $2`,
      [
        t.id,
        expectedVersion,
        t.displayName,
        t.status,
        t.dekVersion,
        JSON.stringify(t.settings),
        JSON.stringify(t.retentionPolicy),
        t.purgeNotBefore,
        t.version,
        t.purgedAt,
      ],
    );
    return rowCount === 1;
  }

  async appendHistory(tx: Tx, change: StatusChange): Promise<void> {
    await tx.query(
      `INSERT INTO tenant_status_history (tenant_id, from_status, to_status, reason, actor, occurred_at)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [change.tenantId, change.from, change.to, change.reason, change.actor, change.occurredAt],
    );
  }

  async insertDataKey(tx: Tx, key: DataKey): Promise<void> {
    await tx.query(
      `INSERT INTO tenant_data_keys (tenant_id, dek_version, kms_key_ref, dek_ciphertext, created_at)
       VALUES ($1, $2, $3, $4, $5)`,
      [key.tenantId, key.version, key.kmsKeyRef, Buffer.from(key.wrappedKey), key.createdAt],
    );
  }

  async retireDataKey(tx: Tx, tenantId: string, version: number, at: Date): Promise<void> {
    await tx.query(
      `UPDATE tenant_data_keys SET retired_at = $3
       WHERE tenant_id = $1 AND dek_version = $2 AND retired_at IS NULL`,
      [tenantId, version, at],
    );
  }

  async destroyDataKeys(tx: Tx, tenantId: string, at: Date): Promise<number> {
    const { rowCount } = await tx.query(
      `UPDATE tenant_data_keys SET dek_ciphertext = NULL, destroyed_at = $2
       WHERE tenant_id = $1 AND destroyed_at IS NULL`,
      [tenantId, at],
    );
    return rowCount;
  }

  async listDataKeys(tx: Tx, tenantId: string): Promise<StoredDataKey[]> {
    const { rows } = await tx.query<{
      dek_version: number;
      kms_key_ref: string;
      dek_ciphertext: Uint8Array;
      retired_at: Date | null;
    }>(
      `SELECT dek_version, kms_key_ref, dek_ciphertext, retired_at FROM tenant_data_keys
       WHERE tenant_id = $1 AND destroyed_at IS NULL ORDER BY dek_version DESC`,
      [tenantId],
    );
    return rows.map((r) => ({
      version: Number(r.dek_version),
      kmsKeyRef: r.kms_key_ref,
      wrappedKey: new Uint8Array(r.dek_ciphertext),
      retiredAt: r.retired_at ? new Date(r.retired_at) : null,
    }));
  }
}
