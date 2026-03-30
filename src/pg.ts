/**
 * PostgreSQL connection pool for NanoClaw Mission Control.
 * Used by the main process, pipelines, and dashboard API routes.
 */
import pg from 'pg';
import { logger } from './logger.js';

const DATABASE_URL =
  process.env.DATABASE_URL || 'postgresql://nanoclaw@localhost:5432/nanoclaw';

let _pool: pg.Pool | null = null;

export function getPool(): pg.Pool {
  if (!_pool) {
    _pool = new pg.Pool({
      connectionString: DATABASE_URL,
      max: 10,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 5000,
    });

    _pool.on('error', (err) => {
      logger.error(`PostgreSQL pool error: ${err.message}`);
    });
  }
  return _pool;
}

/** Run a single query */
export async function query<T extends pg.QueryResultRow = any>(
  text: string,
  params?: any[],
): Promise<pg.QueryResult<T>> {
  return getPool().query<T>(text, params);
}

/** Get a client for transactions */
export async function getClient(): Promise<pg.PoolClient> {
  return getPool().connect();
}

/** Graceful shutdown */
export async function closePool(): Promise<void> {
  if (_pool) {
    await _pool.end();
    _pool = null;
  }
}

/** Health check */
export async function pgHealthCheck(): Promise<boolean> {
  try {
    const result = await query('SELECT 1 as ok');
    return result.rows[0]?.ok === 1;
  } catch {
    return false;
  }
}
