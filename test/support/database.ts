import { Pool } from 'pg';
import { runMigrations } from '../../src/infrastructure/persistence/migrator';

/** Pool hacia la BD de pruebas (PostgreSQL real). Falla con un mensaje claro si no está configurada. */
export function testDatabaseUrl(): string {
  const url = process.env.DATABASE_URL_TEST;
  if (!url) {
    throw new Error('DATABASE_URL_TEST no está definida. Ver README → "Pruebas" (o crear .env.test).');
  }
  return url;
}

export async function createMigratedTestPool(max = 10): Promise<Pool> {
  const pool = new Pool({ connectionString: testDatabaseUrl(), max });
  await runMigrations(pool);
  return pool;
}

export async function resetDatabase(pool: Pool): Promise<void> {
  await pool.query('TRUNCATE notification_attempts, notifications, tracking_events, shipments, webhook_subscriptions RESTART IDENTITY CASCADE');
}

export const TEST_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64');
