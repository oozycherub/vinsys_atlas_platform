import { Injectable } from '@nestjs/common';
import { type Tx } from '@atlas/platform';
import { type CredentialRepository, type LinkRecord } from '../application/ports';
import { type RefreshTokenRecord } from '../domain/tokens';

interface LinkRow {
  id: string;
  tenant_id: string;
  user_id: string;
  expires_at: Date;
  consumed_at: Date | null;
  binding_hash?: Uint8Array;
}

function toLink(row: LinkRow): LinkRecord {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    userId: row.user_id,
    expiresAt: new Date(row.expires_at),
    consumedAt: row.consumed_at ? new Date(row.consumed_at) : null,
    ...(row.binding_hash ? { bindingHash: Buffer.from(row.binding_hash) } : {}),
  };
}

interface RefreshRow {
  token_id: string;
  tenant_id: string;
  user_id: string;
  family_id: string;
  amr: string[];
  expires_at: Date;
  used_at: Date | null;
  revoked_at: Date | null;
}

function toRefresh(row: RefreshRow): RefreshTokenRecord {
  return {
    id: row.token_id,
    tenantId: row.tenant_id,
    userId: row.user_id,
    familyId: row.family_id,
    amr: row.amr,
    expiresAt: new Date(row.expires_at),
    usedAt: row.used_at ? new Date(row.used_at) : null,
    revokedAt: row.revoked_at ? new Date(row.revoked_at) : null,
  };
}

/** Invitations, magic links and refresh tokens. Secrets are looked up by SHA-256 hash only. */
@Injectable()
export class PgCredentialRepository implements CredentialRepository {
  async insertInvitation(
    tx: Tx,
    row: {
      id: string;
      tenantId: string;
      userId: string;
      tokenHash: Buffer;
      invitedBy: string;
      expiresAt: Date;
    },
  ): Promise<void> {
    await tx.query(
      `INSERT INTO user_invitations (invitation_id, tenant_id, user_id, token_hash, invited_by, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [row.id, row.tenantId, row.userId, row.tokenHash, row.invitedBy, row.expiresAt],
    );
  }

  async findInvitation(tx: Tx, tokenHash: Buffer): Promise<LinkRecord | null> {
    const { rows } = await tx.query<LinkRow>(
      `SELECT invitation_id AS id, tenant_id, user_id, expires_at, consumed_at
       FROM user_invitations WHERE token_hash = $1 FOR UPDATE`,
      [tokenHash],
    );
    return rows[0] ? toLink(rows[0]) : null;
  }

  async consumeInvitation(tx: Tx, id: string, at: Date): Promise<boolean> {
    const { rowCount } = await tx.query(
      `UPDATE user_invitations SET consumed_at = $2 WHERE invitation_id = $1 AND consumed_at IS NULL`,
      [id, at],
    );
    return rowCount === 1;
  }

  async supersedeInvitations(tx: Tx, userId: string, at: Date): Promise<number> {
    const { rowCount } = await tx.query(
      `UPDATE user_invitations SET consumed_at = $2 WHERE user_id = $1 AND consumed_at IS NULL`,
      [userId, at],
    );
    return rowCount;
  }

  async insertMagicLink(
    tx: Tx,
    row: {
      id: string;
      tenantId: string;
      userId: string;
      tokenHash: Buffer;
      bindingHash: Buffer;
      expiresAt: Date;
    },
  ): Promise<void> {
    await tx.query(
      `INSERT INTO magic_links (link_id, tenant_id, user_id, token_hash, binding_hash, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [row.id, row.tenantId, row.userId, row.tokenHash, row.bindingHash, row.expiresAt],
    );
  }

  async findMagicLink(tx: Tx, tokenHash: Buffer): Promise<LinkRecord | null> {
    const { rows } = await tx.query<LinkRow>(
      `SELECT link_id AS id, tenant_id, user_id, expires_at, consumed_at, binding_hash
       FROM magic_links WHERE token_hash = $1 FOR UPDATE`,
      [tokenHash],
    );
    return rows[0] ? toLink(rows[0]) : null;
  }

  async consumeMagicLink(tx: Tx, id: string, at: Date): Promise<boolean> {
    const { rowCount } = await tx.query(
      `UPDATE magic_links SET consumed_at = $2 WHERE link_id = $1 AND consumed_at IS NULL`,
      [id, at],
    );
    return rowCount === 1;
  }

  async insertRefreshToken(
    tx: Tx,
    row: RefreshTokenRecord & { tokenHash: Buffer; rotatedFrom: string | null },
  ): Promise<void> {
    await tx.query(
      `INSERT INTO refresh_tokens (token_id, tenant_id, user_id, family_id, token_hash, rotated_from, amr, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7::text[], $8)`,
      [
        row.id,
        row.tenantId,
        row.userId,
        row.familyId,
        row.tokenHash,
        row.rotatedFrom,
        [...row.amr],
        row.expiresAt,
      ],
    );
  }

  async findRefreshToken(tx: Tx, tokenHash: Buffer): Promise<RefreshTokenRecord | null> {
    const { rows } = await tx.query<RefreshRow>(
      `SELECT token_id, tenant_id, user_id, family_id, amr, expires_at, used_at, revoked_at
       FROM refresh_tokens WHERE token_hash = $1 FOR UPDATE`,
      [tokenHash],
    );
    return rows[0] ? toRefresh(rows[0]) : null;
  }

  async markRefreshUsed(tx: Tx, id: string, at: Date): Promise<void> {
    await tx.query(`UPDATE refresh_tokens SET used_at = $2 WHERE token_id = $1`, [id, at]);
  }

  async revokeFamily(tx: Tx, familyId: string, at: Date): Promise<number> {
    const { rowCount } = await tx.query(
      `UPDATE refresh_tokens SET revoked_at = $2 WHERE family_id = $1 AND revoked_at IS NULL`,
      [familyId, at],
    );
    return rowCount;
  }

  async revokeAllForUser(tx: Tx, userId: string, at: Date): Promise<number> {
    const { rowCount } = await tx.query(
      `UPDATE refresh_tokens SET revoked_at = $2 WHERE user_id = $1 AND revoked_at IS NULL`,
      [userId, at],
    );
    return rowCount;
  }
}
