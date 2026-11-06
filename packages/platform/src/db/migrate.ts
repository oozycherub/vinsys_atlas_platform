import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

/** Minimal surface the migrator needs; implemented by node-postgres clients and PGlite. */
export interface MigrationExecutor {
  /** Runs a script that may contain multiple statements. */
  exec(sql: string): Promise<void>;
  query<R>(sql: string, params?: readonly unknown[]): Promise<{ rows: R[] }>;
}

export interface MigrationFile {
  version: number;
  name: string;
  sql: string;
  checksum: string;
}

export interface MigrationReport {
  applied: string[];
  skipped: string[];
}

const FILE_PATTERN = /^(\d{4})_([a-z0-9_]+)\.sql$/;

export async function loadMigrations(dir: string): Promise<MigrationFile[]> {
  const entries = (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort();
  const files: MigrationFile[] = [];
  for (const entry of entries) {
    const match = FILE_PATTERN.exec(entry);
    if (!match?.[1] || !match[2]) {
      throw new Error(`Migration "${entry}" must be named NNNN_snake_case.sql`);
    }
    const sql = await readFile(path.join(dir, entry), 'utf8');
    files.push({
      version: Number(match[1]),
      name: match[2],
      sql,
      checksum: createHash('sha256').update(sql).digest('hex'),
    });
  }
  files.forEach((file, index) => {
    if (file.version !== index + 1) {
      throw new Error(
        `Migration versions must be contiguous from 0001; found ${file.version} at position ${index + 1}`,
      );
    }
  });
  return files;
}

/**
 * Applies pending forward-only migrations in order, each in its own transaction (ADR-0004).
 * Refuses to run if an already-applied file was edited (checksum drift).
 */
export async function runMigrations(
  executor: MigrationExecutor,
  dir: string,
): Promise<MigrationReport> {
  await executor.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version    int PRIMARY KEY,
      name       text NOT NULL,
      checksum   text NOT NULL,
      applied_at timestamptz NOT NULL DEFAULT now()
    )`);
  const applied = new Map(
    (
      await executor.query<{ version: number; checksum: string }>(
        'SELECT version, checksum FROM schema_migrations',
      )
    ).rows.map((row) => [Number(row.version), row.checksum]),
  );
  const report: MigrationReport = { applied: [], skipped: [] };
  for (const file of await loadMigrations(dir)) {
    const label = `${String(file.version).padStart(4, '0')}_${file.name}`;
    const existing = applied.get(file.version);
    if (existing !== undefined) {
      if (existing !== file.checksum) {
        throw new Error(
          `Migration ${label} was modified after it was applied; add a new migration instead.`,
        );
      }
      report.skipped.push(label);
      continue;
    }
    await executor.exec('BEGIN');
    try {
      await executor.exec(file.sql);
      await executor.query(
        'INSERT INTO schema_migrations (version, name, checksum) VALUES ($1, $2, $3)',
        [file.version, file.name, file.checksum],
      );
      await executor.exec('COMMIT');
    } catch (error) {
      await executor.exec('ROLLBACK');
      throw new Error(`Migration ${label} failed: ${(error as Error).message}`);
    }
    report.applied.push(label);
  }
  return report;
}

/** Repository root `db/migrations`, overridable with ATLAS_MIGRATIONS_DIR. */
export function defaultMigrationsDir(): string {
  return (
    process.env['ATLAS_MIGRATIONS_DIR'] ?? path.resolve(__dirname, '../../../../db/migrations')
  );
}
