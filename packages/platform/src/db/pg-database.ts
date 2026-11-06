import { Pool, type PoolConfig } from 'pg';
import { type Database, type QueryResult, type Tx } from './database';

export interface PgDatabaseOptions {
  connectionString: string;
  maxConnections?: number;
  /** Server-side cap per statement; protects the cluster from runaway queries. */
  statementTimeoutMs?: number;
  applicationName?: string;
}

/** node-postgres implementation of Database. Connects as atlas_app (no BYPASSRLS). */
export class PgDatabase implements Database {
  private readonly pool: Pool;

  constructor(options: PgDatabaseOptions) {
    const config: PoolConfig = {
      connectionString: options.connectionString,
      max: options.maxConnections ?? 10,
      application_name: options.applicationName ?? 'atlas',
      statement_timeout: options.statementTimeoutMs ?? 5_000,
    };
    this.pool = new Pool(config);
  }

  async transaction<T>(work: (tx: Tx) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    const tx: Tx = {
      async query<R>(sql: string, params: readonly unknown[] = []): Promise<QueryResult<R>> {
        const result = await client.query(sql, params as unknown[]);
        return { rows: result.rows as R[], rowCount: result.rowCount ?? 0 };
      },
    };
    try {
      await client.query('BEGIN');
      const value = await work(tx);
      await client.query('COMMIT');
      return value;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async ping(): Promise<void> {
    await this.pool.query('SELECT 1');
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}
