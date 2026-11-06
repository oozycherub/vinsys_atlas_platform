import { createHash } from 'node:crypto';
import { type Database, type Tx, withSystemTx } from './db/database';
import { ConflictError, DomainRuleError, ValidationError } from './errors';

export interface IdempotentResponse<T> {
  status: number;
  body: T;
}

export interface IdempotencyRequest {
  /** Who the key belongs to, e.g. `tenant-svc:platform:<subject>`. Keys never collide across scopes. */
  scope: string;
  key: string;
  /** Fingerprint of the request; reusing a key with a different request is rejected. */
  requestHash: string;
}

const KEY_PATTERN = /^[A-Za-z0-9_.:-]{8,128}$/;

/** Stable sha256 over method, path and a canonical JSON body. */
export function hashRequest(method: string, path: string, body: unknown): string {
  return createHash('sha256')
    .update(`${method.toUpperCase()} ${path}\n${canonicalJson(body)}`)
    .digest('hex');
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value ?? null);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    // Code-unit order, not localeCompare: the hash must be identical on every server, whatever its locale.
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
}

export function assertIdempotencyKey(key: string | undefined): string {
  if (key === undefined || key === '') {
    throw new ValidationError('The Idempotency-Key header is required for this operation.', [
      { path: 'headers.idempotency-key', message: 'Required' },
    ]);
  }
  if (!KEY_PATTERN.test(key)) {
    throw new ValidationError('Idempotency-Key must be 8–128 characters of [A-Za-z0-9_.:-].', [
      { path: 'headers.idempotency-key', message: 'Invalid format' },
    ]);
  }
  return key;
}

/**
 * Runs `work` at most once per (scope, key). The key row, the business change and the stored
 * response commit in ONE transaction, so a crash can never record a response without the change
 * (or the reverse). Failed attempts roll back and leave the key free for a retry.
 *
 * - Same key, same request, finished  → stored response is replayed (`replayed: true`).
 * - Same key, same request, in flight → the INSERT waits on the row lock; the replay follows commit.
 * - Same key, different request       → 422 IDEMPOTENCY_KEY_REUSED.
 */
export async function runIdempotent<T>(
  db: Database,
  request: IdempotencyRequest,
  work: (tx: Tx) => Promise<IdempotentResponse<T>>,
): Promise<IdempotentResponse<T> & { replayed: boolean }> {
  return withSystemTx(db, async (tx) => {
    const inserted = await tx.query(
      `INSERT INTO idempotency_keys (scope, idempotency_key, request_hash)
       VALUES ($1, $2, $3)
       ON CONFLICT (scope, idempotency_key) DO NOTHING
       RETURNING idempotency_key`,
      [request.scope, request.key, request.requestHash],
    );
    if (inserted.rowCount === 0) {
      const existing = await tx.query<{
        request_hash: string;
        response_status: number | null;
        response_body: T;
      }>(
        `SELECT request_hash, response_status, response_body FROM idempotency_keys
         WHERE scope = $1 AND idempotency_key = $2`,
        [request.scope, request.key],
      );
      const row = existing.rows[0];
      if (!row)
        throw new ConflictError(
          'IDEMPOTENCY_IN_PROGRESS',
          'A request with this key is still being processed.',
        );
      if (row.request_hash !== request.requestHash) {
        throw new DomainRuleError(
          'IDEMPOTENCY_KEY_REUSED',
          'This Idempotency-Key was already used for a different request.',
        );
      }
      if (row.response_status === null) {
        throw new ConflictError(
          'IDEMPOTENCY_IN_PROGRESS',
          'A request with this key is still being processed.',
        );
      }
      return { status: row.response_status, body: row.response_body, replayed: true };
    }
    const response = await work(tx);
    await tx.query(
      `UPDATE idempotency_keys SET response_status = $3, response_body = $4::jsonb
       WHERE scope = $1 AND idempotency_key = $2`,
      [request.scope, request.key, response.status, JSON.stringify(response.body)],
    );
    return { ...response, replayed: false };
  });
}
