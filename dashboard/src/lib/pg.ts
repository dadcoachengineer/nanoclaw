/**
 * PostgreSQL client for dashboard API routes.
 * Provides query helpers that work in Next.js server context.
 */
import pg from "pg";

const DATABASE_URL =
  process.env.DATABASE_URL || "postgresql://nanoclaw@localhost:5432/nanoclaw";

let _pool: pg.Pool | null = null;

export function getPool(): pg.Pool {
  if (!_pool) {
    _pool = new pg.Pool({
      connectionString: DATABASE_URL,
      max: 5,
      idleTimeoutMillis: 30000,
    });
  }
  return _pool;
}

export async function sql<T extends pg.QueryResultRow = any>(
  text: string,
  params?: any[],
): Promise<T[]> {
  const result = await getPool().query<T>(text, params);
  return result.rows;
}

export async function sqlOne<T extends pg.QueryResultRow = any>(
  text: string,
  params?: any[],
): Promise<T | null> {
  const rows = await sql<T>(text, params);
  return rows[0] || null;
}

export async function sqlCount(table: string, where?: string, params?: any[]): Promise<number> {
  const q = where ? `SELECT COUNT(*) as c FROM ${table} WHERE ${where}` : `SELECT COUNT(*) as c FROM ${table}`;
  const row = await sqlOne<{ c: string }>(q, params);
  return parseInt(row?.c || "0");
}
