import { Pool, PoolClient } from 'pg';

/** Cualquier objeto capaz de ejecutar consultas: el pool o un cliente dentro de una transacción. */
export type Queryable = Pick<Pool, 'query'> | Pick<PoolClient, 'query'>;

export interface PoolSettings {
  connectionString: string;
  max: number;
  ssl: boolean;
  statementTimeoutMs: number;
}

export function createPool(settings: PoolSettings): Pool {
  return new Pool({
    connectionString: settings.connectionString,
    max: settings.max,
    ssl: settings.ssl ? { rejectUnauthorized: true } : undefined,
    statement_timeout: settings.statementTimeoutMs,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
    application_name: 'tracking-notifier',
  });
}

/** Código SQLSTATE de violación de unicidad. */
export const UNIQUE_VIOLATION = '23505';

export function isUniqueViolation(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: string }).code === UNIQUE_VIOLATION;
}
