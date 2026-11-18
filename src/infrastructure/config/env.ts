import { z } from 'zod';

const bool = (fallback: boolean) =>
  z
    .enum(['true', 'false', '1', '0'])
    .default(fallback ? 'true' : 'false')
    .transform((v) => v === 'true' || v === '1');

const int = (fallback: number, min = 0, max = Number.MAX_SAFE_INTEGER) => z.coerce.number().int().min(min).max(max).default(fallback);

/**
 * Configuración 12-factor. Todo llega por variables de entorno (en GCP: Cloud Run +
 * Secret Manager). Valores por defecto SEGUROS: https obligatorio y redes privadas
 * bloqueadas salvo que se habilite explícitamente (solo en desarrollo local).
 */
const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('production'),
  PORT: int(8080, 1, 65535),
  APP_ROLE: z.enum(['all', 'api', 'worker']).default('all'),
  RUN_MIGRATIONS_ON_START: bool(false),
  SHUTDOWN_GRACE_MS: int(8_000, 0, 60_000),

  DATABASE_URL: z.string().min(1).startsWith('postgres'),
  DATABASE_POOL_MAX: int(10, 1, 100),
  DATABASE_SSL: bool(false),
  DATABASE_STATEMENT_TIMEOUT_MS: int(10_000, 100),

  WEBHOOK_SECRET_ENCRYPTION_KEY: z
    .string()
    .refine((v) => Buffer.from(v, 'base64').length === 32, 'debe ser 32 bytes en base64 (openssl rand -base64 32)'),
  WEBHOOK_TIMEOUT_MS: int(5_000, 100, 60_000),
  WEBHOOK_MAX_ATTEMPTS: int(5, 1, 20),
  WEBHOOK_RETRY_BASE_DELAY_MS: int(2_000, 0),
  WEBHOOK_RETRY_MAX_DELAY_MS: int(60_000, 0),
  WEBHOOK_ALLOW_PRIVATE_NETWORKS: bool(false),
  WEBHOOK_REQUIRE_HTTPS: bool(true),

  DISPATCHER_POLL_INTERVAL_MS: int(1_000, 10),
  DISPATCHER_BATCH_SIZE: int(20, 1, 500),
  DISPATCHER_LEASE_MS: int(30_000, 1_000),

  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  LOG_PRETTY: bool(false),
  GOOGLE_CLOUD_PROJECT: z.string().optional(),
  CORS_ORIGINS: z
    .string()
    .optional()
    .transform((v) => (v ? v.split(',').map((o) => o.trim()).filter(Boolean) : [])),
});

export type AppConfig = z.infer<typeof schema>;

export class ConfigError extends Error {}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    // Solo nombres de variables y motivo: nunca se imprimen valores (podrían ser secretos).
    const issues = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new ConfigError(`Configuración inválida → ${issues}`);
  }
  const config = parsed.data;
  if (config.WEBHOOK_TIMEOUT_MS >= config.DISPATCHER_LEASE_MS) {
    throw new ConfigError('Configuración inválida → DISPATCHER_LEASE_MS debe ser mayor que WEBHOOK_TIMEOUT_MS');
  }
  if (config.WEBHOOK_RETRY_MAX_DELAY_MS < config.WEBHOOK_RETRY_BASE_DELAY_MS) {
    throw new ConfigError('Configuración inválida → WEBHOOK_RETRY_MAX_DELAY_MS debe ser >= WEBHOOK_RETRY_BASE_DELAY_MS');
  }
  return config;
}
