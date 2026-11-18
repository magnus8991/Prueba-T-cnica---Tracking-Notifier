import 'reflect-metadata';
import { INestApplication } from '@nestjs/common';
import { Writable } from 'node:stream';
import pino from 'pino';
import { AppConfig, loadConfig } from '../../src/infrastructure/config/env';
import { createApp } from '../../src/infrastructure/nest/create-app';
import { pinoOptions } from '../../src/infrastructure/observability/logger';
import { testDatabaseUrl } from './database';

/** Captura los logs JSON emitidos para poder auditarlos en las pruebas (p.ej. ausencia de PII). */
export class LogCapture extends Writable {
  readonly lines: string[] = [];
  override _write(chunk: Buffer, _enc: BufferEncoding, done: () => void): void {
    this.lines.push(...chunk.toString('utf8').split('\n').filter(Boolean));
    done();
  }
  get text(): string {
    return this.lines.join('\n');
  }
}

/** Configuración E2E: misma app que producción, con tiempos acelerados para que las pruebas sean rápidas. */
export function e2eConfig(overrides: Record<string, string> = {}): AppConfig {
  return loadConfig({
    NODE_ENV: 'test',
    DATABASE_URL: testDatabaseUrl(),
    DATABASE_POOL_MAX: '10',
    WEBHOOK_SECRET_ENCRYPTION_KEY: Buffer.alloc(32, 9).toString('base64'),
    WEBHOOK_ALLOW_PRIVATE_NETWORKS: 'true',
    WEBHOOK_REQUIRE_HTTPS: 'false',
    WEBHOOK_TIMEOUT_MS: '400',
    WEBHOOK_RETRY_BASE_DELAY_MS: '40',
    WEBHOOK_RETRY_MAX_DELAY_MS: '400',
    DISPATCHER_POLL_INTERVAL_MS: '25',
    DISPATCHER_LEASE_MS: '3000',
    LOG_LEVEL: 'info',
    ...overrides,
  });
}

export async function startE2eApp(config: AppConfig = e2eConfig()): Promise<{ app: INestApplication; logs: LogCapture }> {
  const logs = new LogCapture();
  const app = await createApp(config, pino(pinoOptions({ LOG_LEVEL: config.LOG_LEVEL, LOG_PRETTY: false }), logs));
  await app.init();
  return { app, logs };
}

export async function eventually<T>(probe: () => Promise<T>, accept: (value: T) => boolean, timeoutMs = 10_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let last: T = await probe();
  while (!accept(last)) {
    if (Date.now() > deadline) throw new Error(`Condición no alcanzada en ${timeoutMs} ms. Último valor: ${JSON.stringify(last)}`);
    await new Promise((r) => setTimeout(r, 25));
    last = await probe();
  }
  return last;
}
