import { Injectable } from '@nestjs/common';
import { type TenantStatus } from '@atlas/contracts';
import { type Tx } from '@atlas/platform';
import {
  type AuthorizationCode,
  type FederationRepository,
  type FederationState,
  type ServiceClient,
  type ServiceClientRepository,
  type SigningKeyRepository,
  type SsoConnection,
  type SsoRepository,
  type StaffAccount,
  type StaffRepository,
  type StoredSigningKey,
  type TenantAccess,
  type TenantAccessRepository,
} from '../application/ports';

const date = (v: Date | null): Date | null => (v ? new Date(v) : null);

/** Projection of tenant status from tenant-svc events (platform-level, no RLS). */
@Injectable()
export class PgTenantAccessRepository implements TenantAccessRepository {
  async findBySlug(tx: Tx, slug: string): Promise<TenantAccess | null> {
    return this.findOne(tx, 'slug = $1', slug);
  }

  async findById(tx: Tx, tenantId: string): Promise<TenantAccess | null> {
    return this.findOne(tx, 'tenant_id = $1', tenantId);
  }

  async upsert(tx: Tx, a: TenantAccess): Promise<void> {
    await tx.query(
      `INSERT INTO tenant_access (tenant_id, slug, status, updated_at) VALUES ($1, $2, $3, now())
       ON CONFLICT (tenant_id) DO UPDATE SET status = EXCLUDED.status, updated_at = now()`,
      [a.tenantId, a.slug, a.status],
    );
  }

  private async findOne(tx: Tx, where: string, value: string): Promise<TenantAccess | null> {
    const { rows } = await tx.query<{ tenant_id: string; slug: string; status: TenantStatus }>(
      `SELECT tenant_id, slug, status FROM tenant_access WHERE ${where}`,
      [value],
    );
    const row = rows[0];
    return row ? { tenantId: row.tenant_id, slug: row.slug, status: row.status } : null;
  }
}

interface KeyRow {
  kid: string;
  public_jwk: Record<string, unknown>;
  private_key_ciphertext: Uint8Array;
  kek_ref: string;
  created_at: Date;
  activates_at: Date;
  retires_at: Date | null;
  publish_until: Date | null;
}

@Injectable()
export class PgSigningKeyRepository implements SigningKeyRepository {
  async list(tx: Tx): Promise<StoredSigningKey[]> {
    const { rows } = await tx.query<KeyRow>(
      `SELECT kid, public_jwk, private_key_ciphertext, kek_ref, created_at, activates_at, retires_at, publish_until
       FROM signing_keys ORDER BY activates_at DESC`,
    );
    return rows.map((r) => ({
      kid: r.kid,
      publicJwk: r.public_jwk,
      privateKeyCiphertext: Buffer.from(r.private_key_ciphertext),
      kekRef: r.kek_ref,
      createdAt: new Date(r.created_at),
      activatesAt: new Date(r.activates_at),
      retiresAt: date(r.retires_at),
      publishUntil: date(r.publish_until),
    }));
  }

  async insert(tx: Tx, k: StoredSigningKey): Promise<void> {
    await tx.query(
      `INSERT INTO signing_keys (kid, alg, public_jwk, private_key_ciphertext, kek_ref, created_at, activates_at)
       VALUES ($1, 'ES256', $2::jsonb, $3, $4, $5, $6)`,
      [
        k.kid,
        JSON.stringify(k.publicJwk),
        k.privateKeyCiphertext,
        k.kekRef,
        k.createdAt,
        k.activatesAt,
      ],
    );
  }

  async retire(tx: Tx, kid: string, retiresAt: Date, publishUntil: Date): Promise<boolean> {
    const { rowCount } = await tx.query(
      `UPDATE signing_keys SET retires_at = $2, publish_until = $3 WHERE kid = $1 AND retires_at IS NULL`,
      [kid, retiresAt, publishUntil],
    );
    return rowCount === 1;
  }

  async lockForRotation(tx: Tx): Promise<void> {
    await tx.query('LOCK TABLE signing_keys IN SHARE ROW EXCLUSIVE MODE');
  }
}

interface ClientRow {
  client_id: string;
  tenant_id: string | null;
  secret_hash: string;
  scopes: string[];
  description: string;
  disabled_at: Date | null;
  created_by: string;
  created_at: Date;
}

@Injectable()
export class PgServiceClientRepository implements ServiceClientRepository {
  async find(tx: Tx, clientId: string): Promise<ServiceClient | null> {
    const { rows } = await tx.query<ClientRow>(
      `SELECT client_id, tenant_id, secret_hash, scopes, description, disabled_at, created_by, created_at
       FROM service_clients WHERE client_id = $1`,
      [clientId],
    );
    const r = rows[0];
    return r
      ? {
          clientId: r.client_id,
          tenantId: r.tenant_id,
          secretHash: r.secret_hash,
          scopes: r.scopes,
          description: r.description,
          disabledAt: date(r.disabled_at),
          createdBy: r.created_by,
          createdAt: new Date(r.created_at),
        }
      : null;
  }

  async insert(tx: Tx, c: ServiceClient): Promise<void> {
    await tx.query(
      `INSERT INTO service_clients (client_id, tenant_id, secret_hash, scopes, description, created_by, created_at)
       VALUES ($1, $2, $3, $4::text[], $5, $6, $7)`,
      [
        c.clientId,
        c.tenantId,
        c.secretHash,
        [...c.scopes],
        c.description,
        c.createdBy,
        c.createdAt,
      ],
    );
  }
}

interface SsoRow {
  tenant_id: string;
  protocol: 'oidc' | 'saml';
  enforced: boolean;
  metadata: Record<string, unknown>;
  domain_hints: string[];
  client_secret_ciphertext: Uint8Array | null;
  kek_ref: string | null;
  jit_role: string | null;
  version: number;
  updated_at: Date;
}

/** Tenant-owned (RLS): the caller's transaction carries the tenant context. */
@Injectable()
export class PgSsoRepository implements SsoRepository {
  async find(tx: Tx): Promise<SsoConnection | null> {
    const { rows } = await tx.query<SsoRow>(
      `SELECT tenant_id, protocol, enforced, metadata, domain_hints, client_secret_ciphertext, kek_ref,
         jit_role, version, updated_at
       FROM sso_connections WHERE tenant_id = current_tenant_id()`,
    );
    const r = rows[0];
    return r
      ? {
          tenantId: r.tenant_id,
          protocol: r.protocol,
          enforced: r.enforced,
          metadata: r.metadata,
          domainHints: r.domain_hints,
          clientSecretCiphertext: r.client_secret_ciphertext
            ? Buffer.from(r.client_secret_ciphertext)
            : null,
          kekRef: r.kek_ref,
          jitRole: r.jit_role,
          version: Number(r.version),
          updatedAt: new Date(r.updated_at),
        }
      : null;
  }

  async upsert(tx: Tx, c: SsoConnection, expectedVersion: number | null): Promise<boolean> {
    const values = [
      c.tenantId,
      c.protocol,
      c.enforced,
      JSON.stringify(c.metadata),
      [...c.domainHints],
      c.clientSecretCiphertext,
      c.kekRef,
      c.jitRole,
      c.version,
    ];
    if (expectedVersion === null) {
      const { rowCount } = await tx.query(
        `INSERT INTO sso_connections (tenant_id, protocol, enforced, metadata, domain_hints,
           client_secret_ciphertext, kek_ref, jit_role, version)
         VALUES ($1, $2, $3, $4::jsonb, $5::text[], $6, $7, $8, $9) ON CONFLICT (tenant_id) DO NOTHING`,
        values,
      );
      return rowCount === 1;
    }
    const { rowCount } = await tx.query(
      `UPDATE sso_connections SET protocol = $2, enforced = $3, metadata = $4::jsonb, domain_hints = $5::text[],
         client_secret_ciphertext = $6, kek_ref = $7, jit_role = $8, version = $9
       WHERE tenant_id = $1 AND version = $10`,
      [...values, expectedVersion],
    );
    return rowCount === 1;
  }

  async deleteForTenant(tx: Tx): Promise<void> {
    await tx.query(`DELETE FROM sso_connections WHERE tenant_id = current_tenant_id()`);
  }
}

interface StateRow {
  state_hash: Uint8Array;
  kind: 'tenant' | 'staff';
  tenant_id: string | null;
  protocol: 'oidc' | 'saml';
  nonce: string | null;
  idp_code_verifier: string | null;
  saml_request_id: string | null;
  client_id: string;
  redirect_uri: string;
  code_challenge: string;
  client_state: string;
  expires_at: Date;
  consumed_at: Date | null;
}

interface CodeRow {
  code_hash: Uint8Array;
  kind: 'tenant' | 'staff';
  tenant_id: string | null;
  subject_id: string;
  client_id: string;
  redirect_uri: string;
  code_challenge: string;
  amr: string[];
  expires_at: Date;
  consumed_at: Date | null;
}

/** In-flight federated logins and authorization codes, looked up by SHA-256 hash only. */
@Injectable()
export class PgFederationRepository implements FederationRepository {
  async insertState(tx: Tx, f: FederationState): Promise<void> {
    await tx.query(
      `INSERT INTO federation_states (state_hash, kind, tenant_id, protocol, nonce, idp_code_verifier,
         saml_request_id, client_id, redirect_uri, code_challenge, client_state, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
      [
        f.stateHash,
        f.kind,
        f.tenantId,
        f.protocol,
        f.nonce,
        f.idpCodeVerifier,
        f.samlRequestId,
        f.clientId,
        f.redirectUri,
        f.codeChallenge,
        f.clientState,
        f.expiresAt,
      ],
    );
  }

  async findState(tx: Tx, stateHash: Buffer): Promise<FederationState | null> {
    const { rows } = await tx.query<StateRow>(
      `SELECT state_hash, kind, tenant_id, protocol, nonce, idp_code_verifier, saml_request_id, client_id,
         redirect_uri, code_challenge, client_state, expires_at, consumed_at
       FROM federation_states WHERE state_hash = $1 FOR UPDATE`,
      [stateHash],
    );
    const r = rows[0];
    return r
      ? {
          stateHash: Buffer.from(r.state_hash),
          kind: r.kind,
          tenantId: r.tenant_id,
          protocol: r.protocol,
          nonce: r.nonce,
          idpCodeVerifier: r.idp_code_verifier,
          samlRequestId: r.saml_request_id,
          clientId: r.client_id,
          redirectUri: r.redirect_uri,
          codeChallenge: r.code_challenge,
          clientState: r.client_state,
          expiresAt: new Date(r.expires_at),
          consumedAt: date(r.consumed_at),
        }
      : null;
  }

  async consumeState(tx: Tx, stateHash: Buffer, at: Date): Promise<boolean> {
    const { rowCount } = await tx.query(
      `UPDATE federation_states SET consumed_at = $2 WHERE state_hash = $1 AND consumed_at IS NULL`,
      [stateHash, at],
    );
    return rowCount === 1;
  }

  async insertCode(tx: Tx, c: AuthorizationCode): Promise<void> {
    await tx.query(
      `INSERT INTO authorization_codes (code_hash, kind, tenant_id, subject_id, client_id, redirect_uri,
         code_challenge, amr, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8::text[], $9)`,
      [
        c.codeHash,
        c.kind,
        c.tenantId,
        c.subjectId,
        c.clientId,
        c.redirectUri,
        c.codeChallenge,
        [...c.amr],
        c.expiresAt,
      ],
    );
  }

  async findCode(tx: Tx, codeHash: Buffer): Promise<AuthorizationCode | null> {
    const { rows } = await tx.query<CodeRow>(
      `SELECT code_hash, kind, tenant_id, subject_id, client_id, redirect_uri, code_challenge, amr,
         expires_at, consumed_at
       FROM authorization_codes WHERE code_hash = $1 FOR UPDATE`,
      [codeHash],
    );
    const r = rows[0];
    return r
      ? {
          codeHash: Buffer.from(r.code_hash),
          kind: r.kind,
          tenantId: r.tenant_id,
          subjectId: r.subject_id,
          clientId: r.client_id,
          redirectUri: r.redirect_uri,
          codeChallenge: r.code_challenge,
          amr: r.amr,
          expiresAt: new Date(r.expires_at),
          consumedAt: date(r.consumed_at),
        }
      : null;
  }

  async consumeCode(tx: Tx, codeHash: Buffer, at: Date): Promise<boolean> {
    const { rowCount } = await tx.query(
      `UPDATE authorization_codes SET consumed_at = $2 WHERE code_hash = $1 AND consumed_at IS NULL`,
      [codeHash, at],
    );
    return rowCount === 1;
  }
}

interface StaffRow {
  staff_id: string;
  email: string;
  display_name: string;
  roles: 'super_admin'[];
  status: 'active' | 'disabled';
  last_login_at: Date | null;
  created_by: string;
  created_at: Date;
}

const STAFF_COLUMNS =
  'staff_id, email, display_name, roles, status, last_login_at, created_by, created_at';

function toStaff(r: StaffRow): StaffAccount {
  return {
    id: r.staff_id,
    email: r.email,
    displayName: r.display_name,
    roles: r.roles,
    status: r.status,
    lastLoginAt: date(r.last_login_at),
    createdBy: r.created_by,
    createdAt: new Date(r.created_at),
  };
}

/** Platform staff (super_admin) accounts. */
@Injectable()
export class PgStaffRepository implements StaffRepository {
  async findByEmail(tx: Tx, email: string): Promise<StaffAccount | null> {
    const { rows } = await tx.query<StaffRow>(
      `SELECT ${STAFF_COLUMNS} FROM staff_accounts WHERE email = $1`,
      [email],
    );
    return rows[0] ? toStaff(rows[0]) : null;
  }

  async findById(tx: Tx, id: string): Promise<StaffAccount | null> {
    const { rows } = await tx.query<StaffRow>(
      `SELECT ${STAFF_COLUMNS} FROM staff_accounts WHERE staff_id = $1`,
      [id],
    );
    return rows[0] ? toStaff(rows[0]) : null;
  }

  async list(tx: Tx): Promise<StaffAccount[]> {
    const { rows } = await tx.query<StaffRow>(
      `SELECT ${STAFF_COLUMNS} FROM staff_accounts ORDER BY created_at, staff_id`,
    );
    return rows.map(toStaff);
  }

  async insert(tx: Tx, a: StaffAccount): Promise<boolean> {
    const { rowCount } = await tx.query(
      `INSERT INTO staff_accounts (staff_id, email, display_name, roles, status, created_by, created_at)
       VALUES ($1, $2, $3, $4::text[], $5, $6, $7) ON CONFLICT (email) DO NOTHING`,
      [a.id, a.email, a.displayName, [...a.roles], a.status, a.createdBy, a.createdAt],
    );
    return rowCount === 1;
  }

  async setStatus(tx: Tx, id: string, status: StaffAccount['status']): Promise<boolean> {
    const { rowCount } = await tx.query(
      `UPDATE staff_accounts SET status = $2 WHERE staff_id = $1`,
      [id, status],
    );
    return rowCount === 1;
  }

  async recordLogin(tx: Tx, id: string, at: Date): Promise<void> {
    await tx.query(`UPDATE staff_accounts SET last_login_at = $2 WHERE staff_id = $1`, [id, at]);
  }
}
