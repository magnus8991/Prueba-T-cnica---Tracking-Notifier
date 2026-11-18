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

/**
 * Limpia la BD entre pruebas. En E2E el worker de la app sigue sondeando la cola mientras se trunca,
 * y PostgreSQL puede abortar el TRUNCATE por deadlock (40P01) o timeout de lock (55P03): se reintenta.
 */
export async function resetDatabase(pool: Pool): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    try {
      await pool.query('TRUNCATE notification_attempts, notifications, tracking_events, shipments, webhook_subscriptions RESTART IDENTITY CASCADE');
      return;
    } catch (error) {
      const code = (error as { code?: string }).code;
      if ((code !== '40P01' && code !== '55P03') || attempt >= 10) throw error;
      await new Promise((r) => setTimeout(r, 20 * attempt));
    }
  }
}

export const TEST_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64');
