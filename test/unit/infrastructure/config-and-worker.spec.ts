import { loadConfig } from '../../../src/infrastructure/config/env';
import { NotificationWorker } from '../../../src/infrastructure/worker/notification-worker';
import { DispatchDueNotifications } from '../../../src/application/use-cases/dispatch-due-notifications';
import { captureError } from '../../support/capture-error';
import { SilentLogger } from '../../support/in-memory';

describe('Configuración (12-factor, fail-fast)', () => {
  const minimal = {
    DATABASE_URL: 'postgresql://user:pw@localhost:5432/db',
    WEBHOOK_SECRET_ENCRYPTION_KEY: Buffer.alloc(32, 1).toString('base64'),
  };

  it('los valores por defecto cumplen el enunciado: timeout 5 s y 5 intentos', () => {
    const config = loadConfig(minimal);
    expect(config.WEBHOOK_TIMEOUT_MS).toBe(5000);
    expect(config.WEBHOOK_MAX_ATTEMPTS).toBe(5);
  });

  it('es segura por defecto: https obligatorio y redes privadas bloqueadas', () => {
    const config = loadConfig(minimal);
    expect(config.WEBHOOK_REQUIRE_HTTPS).toBe(true);
    expect(config.WEBHOOK_ALLOW_PRIVATE_NETWORKS).toBe(false);
    expect(config.APP_ROLE).toBe('all');
    expect(config.PORT).toBe(8080); // puerto por defecto de Cloud Run
  });

  it('falla al arrancar si falta un secreto, sin imprimir valores', () => {
    const error = captureError(() => loadConfig({ DATABASE_URL: 'postgresql://user:SuperSecreto@db/x' }));
    expect(error.message).toContain('WEBHOOK_SECRET_ENCRYPTION_KEY');
    expect(error.message).not.toContain('SuperSecreto');
  });

  it('rechaza una clave de cifrado que no sea de 32 bytes', () => {
    expect(() => loadConfig({ ...minimal, WEBHOOK_SECRET_ENCRYPTION_KEY: 'corta' })).toThrow(/32 bytes/);
  });

  it('exige que el lease del worker supere el timeout del webhook (evita doble envío)', () => {
    expect(() => loadConfig({ ...minimal, WEBHOOK_TIMEOUT_MS: '5000', DISPATCHER_LEASE_MS: '4000' })).toThrow(/LEASE/);
  });

  it('parsea CORS_ORIGINS como lista', () => {
    expect(loadConfig({ ...minimal, CORS_ORIGINS: 'https://a.example.com, https://b.example.com' }).CORS_ORIGINS).toEqual([
      'https://a.example.com',
      'https://b.example.com',
    ]);
  });
});

describe('NotificationWorker', () => {
  const flush = () => new Promise((r) => setTimeout(r, 30));

  it('ejecuta un ciclo al iniciar, responde a notify() y se detiene ordenadamente', async () => {
    let calls = 0;
    const dispatch = { execute: async () => (calls++, 0) } as unknown as DispatchDueNotifications;
    const worker = new NotificationWorker(dispatch, new SilentLogger(), { pollIntervalMs: 60_000 }, 10);

    worker.start();
    await flush();
    expect(calls).toBe(1);

    worker.notify();
    await flush();
    expect(calls).toBe(2);

    await worker.stop();
    worker.notify();
    await flush();
    expect(calls).toBe(2);
  });

  it('drena la cola sin esperar al polling cuando el lote vino lleno', async () => {
    const batches = [10, 10, 3];
    let calls = 0;
    const dispatch = { execute: async () => (calls++, batches.shift() ?? 0) } as unknown as DispatchDueNotifications;
    // Polling de 60 s: si no drenara de inmediato, la prueba excedería su timeout.
    const worker = new NotificationWorker(dispatch, new SilentLogger(), { pollIntervalMs: 60_000 }, 10);
    worker.start();
    while (calls < 3) await new Promise((r) => setTimeout(r, 5));
    await worker.stop();
    expect(batches).toEqual([]);
    expect(calls).toBe(3); // el lote de 3 (< tamaño) no dispara otro ciclo inmediato
  });

  it('un error en el ciclo no detiene el worker', async () => {
    let calls = 0;
    const logger = new SilentLogger();
    const dispatch = {
      execute: async () => {
        calls++;
        if (calls === 1) throw new Error('BD caída');
        return 0;
      },
    } as unknown as DispatchDueNotifications;
    const worker = new NotificationWorker(dispatch, logger, { pollIntervalMs: 5 }, 10);
    worker.start();
    await flush();
    await worker.stop();
    expect(calls).toBeGreaterThan(1);
    expect(logger.entries.some((e) => e.level === 'error')).toBe(true);
  });
});
