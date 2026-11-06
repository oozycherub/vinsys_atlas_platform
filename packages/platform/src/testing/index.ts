/* Test-only helpers (ADR-0005). Never imported by production code. */
import { PGlite } from '@electric-sql/pglite';
import { ltree } from '@electric-sql/pglite/contrib/ltree';
import { pg_trgm } from '@electric-sql/pglite/contrib/pg_trgm';
import { vector } from '@electric-sql/pglite-pgvector';
import { SignJWT } from 'jose';
import { type Role } from '@atlas/contracts';
import { type Database, type QueryResult, type Tx } from '../db/database';
import { defaultMigrationsDir, type MigrationReport, runMigrations } from '../db/migrate';

export const TEST_AUTH = {
  issuer: 'https://identity.atlas.test',
  audience: 'atlas-api',
  sharedSecret: 'test-only-shared-secret-at-least-32-chars!',
} as const;

export interface TestTokenClaims {
  sub: string;
  tid?: string | null;
  roles: Role[];
  scopes?: string[];
  expiresIn?: string;
}

export async function signTestToken(
  claims: TestTokenClaims,
  secret: string = TEST_AUTH.sharedSecret,
): Promise<string> {
  return new SignJWT({ tid: claims.tid ?? null, roles: claims.roles, scopes: claims.scopes ?? [] })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(claims.sub)
    .setIssuer(TEST_AUTH.issuer)
    .setAudience(TEST_AUTH.audience)
    .setIssuedAt()
    .setExpirationTime(claims.expiresIn ?? '5m')
    .sign(new TextEncoder().encode(secret));
}

export interface TestDatabase extends Database {
  /** Superuser access for fixtures and assertions; bypasses RLS. Never use for code under test. */
  readonly owner: Tx;
  readonly migrations: MigrationReport;
}

type PGliteTx = Parameters<Parameters<PGlite['transaction']>[0]>[0];

function wrap(target: { query: PGliteTx['query'] }): Tx {
  return {
    async query<R>(sql: string, params: readonly unknown[] = []): Promise<QueryResult<R>> {
      const result = await target.query<R>(sql, params as unknown[]);
      return { rows: result.rows, rowCount: result.affectedRows ?? result.rows.length };
    },
  };
}

/**
 * In-process Postgres with every migration applied. Application transactions run as
 * `atlas_app` (SET LOCAL ROLE), so row-level security behaves exactly as in production.
 */
export async function createTestDatabase(
  options: { migrationsDir?: string } = {},
): Promise<TestDatabase> {
  // The extensions production Postgres provides (pgvector image + contrib).
  const pg = await PGlite.create({ extensions: { ltree, pg_trgm, vector } });
  const migrations = await runMigrations(
    {
      exec: async (sql) => {
        await pg.exec(sql);
      },
      query: async <R>(sql: string, params: readonly unknown[] = []) =>
        pg.query<R>(sql, params as unknown[]),
    },
    options.migrationsDir ?? defaultMigrationsDir(),
  );
  return {
    owner: wrap(pg),
    migrations,
    transaction<T>(work: (tx: Tx) => Promise<T>): Promise<T> {
      return pg.transaction(async (tx) => {
        await tx.query('SET LOCAL ROLE atlas_app');
        return work(wrap(tx));
      });
    },
    async ping() {
      await pg.query('SELECT 1');
    },
    async close() {
      await pg.close();
    },
  };
}

/** Collects log lines written by pino so tests can assert on them (e.g. PII redaction). */
export class MemoryLogStream {
  readonly lines: Record<string, unknown>[] = [];

  write(chunk: string): void {
    for (const line of chunk.split('\n')) {
      if (line.trim()) this.lines.push(JSON.parse(line) as Record<string, unknown>);
    }
  }
}
