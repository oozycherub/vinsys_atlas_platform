import { Injectable } from '@nestjs/common';
import { type TenantRole } from '@atlas/contracts';
import { type Tx } from '@atlas/platform';
import { type UserListFilter, type UserRepository } from '../application/ports';
import { type User, type UserStatus } from '../domain/user';

interface UserRow {
  user_id: string;
  tenant_id: string;
  email: string;
  display_name: string;
  roles: TenantRole[];
  business_unit_ids: string[];
  status: UserStatus;
  last_login_at: Date | null;
  version: number;
  created_at: Date;
  updated_at: Date;
}

const COLUMNS = `user_id, tenant_id, email, display_name, roles, business_unit_ids, status, last_login_at,
  version, created_at, updated_at`;

function toUser(row: UserRow): User {
  return {
    id: row.user_id,
    tenantId: row.tenant_id,
    email: row.email,
    displayName: row.display_name,
    roles: row.roles,
    businessUnitIds: row.business_unit_ids,
    status: row.status,
    lastLoginAt: row.last_login_at ? new Date(row.last_login_at) : null,
    version: Number(row.version),
    createdAt: new Date(row.created_at),
    updatedAt: new Date(row.updated_at),
  };
}

/** SQL-first repository over `users` (ADR-0004). RLS scopes every statement to one tenant. */
@Injectable()
export class PgUserRepository implements UserRepository {
  async insert(tx: Tx, u: User): Promise<void> {
    await tx.query(
      `INSERT INTO users (user_id, tenant_id, email, display_name, roles, business_unit_ids, status,
         last_login_at, version, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5::text[], $6::uuid[], $7, $8, $9, $10, $11)`,
      [
        u.id,
        u.tenantId,
        u.email,
        u.displayName,
        [...u.roles],
        [...u.businessUnitIds],
        u.status,
        u.lastLoginAt,
        u.version,
        u.createdAt,
        u.updatedAt,
      ],
    );
  }

  async findById(tx: Tx, id: string, options: { forUpdate?: boolean } = {}): Promise<User | null> {
    const { rows } = await tx.query<UserRow>(
      `SELECT ${COLUMNS} FROM users WHERE user_id = $1${options.forUpdate ? ' FOR UPDATE' : ''}`,
      [id],
    );
    return rows[0] ? toUser(rows[0]) : null;
  }

  async findByEmail(tx: Tx, email: string): Promise<User | null> {
    const { rows } = await tx.query<UserRow>(`SELECT ${COLUMNS} FROM users WHERE email = $1`, [
      email,
    ]);
    return rows[0] ? toUser(rows[0]) : null;
  }

  async list(tx: Tx, filter: UserListFilter): Promise<User[]> {
    const { rows } = await tx.query<UserRow>(
      `SELECT ${COLUMNS} FROM users
       WHERE ($1::timestamptz IS NULL OR (created_at, user_id) < ($1::timestamptz, $2::uuid))
       ORDER BY created_at DESC, user_id DESC
       LIMIT $3`,
      [filter.after?.createdAt ?? null, filter.after?.id ?? null, filter.limit],
    );
    return rows.map(toUser);
  }

  async update(tx: Tx, u: User, expectedVersion: number): Promise<boolean> {
    const { rowCount } = await tx.query(
      `UPDATE users SET display_name = $3, roles = $4::text[], business_unit_ids = $5::uuid[], status = $6,
         last_login_at = $7, version = $8
       WHERE user_id = $1 AND version = $2`,
      [
        u.id,
        expectedVersion,
        u.displayName,
        [...u.roles],
        [...u.businessUnitIds],
        u.status,
        u.lastLoginAt,
        u.version,
      ],
    );
    return rowCount === 1;
  }

  async deleteAll(tx: Tx): Promise<number> {
    // RLS limits this to the tenant in context; the WHERE makes the intent explicit.
    const { rowCount } = await tx.query(`DELETE FROM users WHERE tenant_id = current_tenant_id()`);
    return rowCount;
  }
}
