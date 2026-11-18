import { loadConfig } from '../config/env';
import { createRootLogger } from '../observability/logger';
import { runMigrations } from './migrator';
import { createPool } from './pg-pool';

/** CLI de migraciones: `npm run migrate` (o como job previo al despliegue en Cloud Run). */
async function main(): Promise<void> {
  const config = loadConfig();
  const logger = createRootLogger(config);
  const pool = createPool({ connectionString: config.DATABASE_URL, max: 1, ssl: config.DATABASE_SSL, statementTimeoutMs: 60_000 });
  try {
    const applied = await runMigrations(pool);
    logger.info({ applied }, applied.length ? 'Migraciones aplicadas' : 'Esquema al día');
  } finally {
    await pool.end();
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`${JSON.stringify({ severity: 'CRITICAL', message: (error as Error).message })}\n`);
  process.exit(1);
});
