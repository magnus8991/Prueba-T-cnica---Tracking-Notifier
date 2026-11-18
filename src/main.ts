import 'reflect-metadata';
import { ConfigError, loadConfig } from './infrastructure/config/env';
import { createApp } from './infrastructure/nest/create-app';
import { createRootLogger } from './infrastructure/observability/logger';
import { createPool } from './infrastructure/persistence/pg-pool';
import { runMigrations } from './infrastructure/persistence/migrator';

async function bootstrap(): Promise<void> {
  const config = loadConfig();
  const logger = createRootLogger(config);

  if (config.RUN_MIGRATIONS_ON_START) {
    const pool = createPool({ connectionString: config.DATABASE_URL, max: 1, ssl: config.DATABASE_SSL, statementTimeoutMs: 60_000 });
    try {
      const applied = await runMigrations(pool);
      logger.info({ applied }, 'Migraciones verificadas');
    } finally {
      await pool.end();
    }
  }

  const app = await createApp(config, logger);
  await app.listen(config.PORT, '0.0.0.0');
  logger.info({ port: config.PORT, role: config.APP_ROLE }, 'tracking-notifier escuchando');
}

bootstrap().catch((error: unknown) => {
  // Logger mínimo: si la configuración es inválida aún no hay logger configurado.
  const message = error instanceof ConfigError ? error.message : 'Fallo al iniciar el servicio';
  process.stderr.write(`${JSON.stringify({ severity: 'CRITICAL', level: 'fatal', message, error: error instanceof Error ? error.name : undefined })}\n`);
  process.exit(1);
});
