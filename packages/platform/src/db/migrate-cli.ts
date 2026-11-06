/* Applies migrations against a real Postgres. Usage: ATLAS_DATABASE_OWNER_URL=... npm run migrate */
import { Client } from 'pg';
import { defaultMigrationsDir, runMigrations } from './migrate';

async function main(): Promise<void> {
  const url = process.env['ATLAS_DATABASE_OWNER_URL'];
  if (!url) throw new Error('ATLAS_DATABASE_OWNER_URL is required (connect as atlas_owner).');
  const client = new Client({ connectionString: url });
  await client.connect();
  try {
    const report = await runMigrations(
      {
        exec: async (sql) => {
          await client.query(sql);
        },
        query: async <R>(sql: string, params: readonly unknown[] = []) => {
          const result = await client.query(sql, params as unknown[]);
          return { rows: result.rows as R[] };
        },
      },
      defaultMigrationsDir(),
    );
    process.stdout.write(`${JSON.stringify({ msg: 'migrations complete', ...report })}\n`);
  } finally {
    await client.end();
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`${(error as Error).message}\n`);
  process.exit(1);
});
