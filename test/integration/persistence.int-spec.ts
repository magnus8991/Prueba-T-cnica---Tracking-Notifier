import { Pool } from 'pg';
import { RegisterTrackingEvent, RegisterTrackingEventCommand } from '../../src/application/use-cases/register-tracking-event';
import { GetShipmentHistory } from '../../src/application/use-cases/get-shipment-history';
import { Notification } from '../../src/domain/notification/notification';
import { ExponentialBackoffPolicy } from '../../src/domain/notification/retry-policy';
import { EventId } from '../../src/domain/shipment/event-id';
import { TrackingNumber } from '../../src/domain/shipment/tracking-number';
import { TenantId } from '../../src/domain/tenant/tenant-id';
import { WebhookSubscription } from '../../src/domain/webhook/webhook-subscription';
import { WebhookUrl } from '../../src/domain/webhook/webhook-url';
import { AesGcmSecretCipher } from '../../src/infrastructure/crypto/aes-gcm-secret-cipher';
import { CryptoIdGenerator, RandomSecretGenerator } from '../../src/infrastructure/crypto/system-adapters';
import { ConfigureWebhook } from '../../src/application/use-cases/configure-webhook';
import { runMigrations } from '../../src/infrastructure/persistence/migrator';
import { PgTransactionRunner } from '../../src/infrastructure/persistence/pg-transaction-runner';
import { PgNotificationRepository } from '../../src/infrastructure/persistence/repositories/pg-notification-repository';
import { PgShipmentRepository } from '../../src/infrastructure/persistence/repositories/pg-shipment-repository';
import { PgTrackingEventRepository } from '../../src/infrastructure/persistence/repositories/pg-tracking-event-repository';
import { PgWebhookSubscriptionRepository } from '../../src/infrastructure/persistence/repositories/pg-webhook-subscription-repository';
import { captureAsyncError } from '../support/capture-error';
import { createMigratedTestPool, resetDatabase, TEST_ENCRYPTION_KEY } from '../support/database';
import { FixedClock, SpyWorkSignal } from '../support/in-memory';

describe('Persistencia PostgreSQL (integración real)', () => {
  let pool: Pool;
  let clock: FixedClock;
  let register: RegisterTrackingEvent;
  const notifications = () => new PgNotificationRepository(pool);

  const cmd = (overrides: Partial<RegisterTrackingEventCommand> = {}): RegisterTrackingEventCommand => ({
    tenantId: 'tenant-a',
    trackingNumber: 'GUIA-0001',
    eventId: new CryptoIdGenerator().uuid(),
    status: 'CREADA',
    occurredAt: new Date('2026-11-01T09:00:00Z'),
    observation: null,
    ...overrides,
  });

  beforeAll(async () => {
    pool = await createMigratedTestPool(20);
  });
  afterAll(async () => {
    await pool.end();
  });
  beforeEach(async () => {
    await resetDatabase(pool);
    clock = new FixedClock();
    register = new RegisterTrackingEvent(new PgTransactionRunner(pool), clock, new CryptoIdGenerator(), new SpyWorkSignal(), 5);
  });

  it('las migraciones son idempotentes (re-ejecutar no aplica nada)', async () => {
    expect(await runMigrations(pool)).toEqual([]);
  });

  it('registra evento + guía + notificación en una sola transacción', async () => {
    await register.execute(cmd({ observation: 'Dato ficticio' }));
    const counts = await pool.query(
      `SELECT (SELECT count(*) FROM shipments)::int s, (SELECT count(*) FROM tracking_events)::int e, (SELECT count(*) FROM notifications)::int n`,
    );
    expect(counts.rows[0]).toEqual({ s: 1, e: 1, n: 1 });
  });

  it('IDEMPOTENCIA BAJO CONCURRENCIA: 20 peticiones simultáneas con el mismo eventId → 1 evento y 1 notificación', async () => {
    const same = cmd();
    const results = await Promise.all(Array.from({ length: 20 }, () => register.execute(same)));

    expect(results.filter((r) => r.outcome === 'CREATED')).toHaveLength(1);
    expect(results.filter((r) => r.outcome === 'REPLAYED')).toHaveLength(19);
    const { rows } = await pool.query('SELECT (SELECT count(*) FROM tracking_events)::int e, (SELECT count(*) FROM notifications)::int n');
    expect(rows[0]).toEqual({ e: 1, n: 1 });
  });

  it('REGLA TERMINAL BAJO CONCURRENCIA: ENTREGADA y EN_RUTA simultáneos nunca dejan la guía reabierta', async () => {
    await register.execute(cmd({ status: 'EN_RUTA' }));
    const outcomes = await Promise.allSettled([
      register.execute(cmd({ status: 'ENTREGADA', occurredAt: new Date('2026-11-01T12:00:00Z') })),
      register.execute(cmd({ status: 'EN_RUTA', occurredAt: new Date('2026-11-01T13:00:00Z') })),
    ]);
    const history = await new GetShipmentHistory(new PgShipmentRepository(pool), new PgTrackingEventRepository(pool)).execute({
      tenantId: 'tenant-a',
      trackingNumber: 'GUIA-0001',
    });
    // Si ENTREGADA ganó, EN_RUTA fue rechazado; si EN_RUTA ganó, ENTREGADA lo cierra después. En ambos casos queda ENTREGADA.
    expect(history.shipment.currentStatus).toBe('ENTREGADA');
    expect(outcomes.filter((o) => o.status === 'fulfilled').length).toBeGreaterThanOrEqual(1);
  });

  it('historial en orden cronológico con desempate por orden de llegada', async () => {
    const t = new Date('2026-11-01T10:00:00Z');
    await register.execute(cmd({ eventId: 'a0000000-0000-4000-8000-000000000003', status: 'EN_RUTA', occurredAt: new Date('2026-11-01T12:00:00Z') }));
    await register.execute(cmd({ eventId: 'a0000000-0000-4000-8000-000000000001', status: 'CREADA', occurredAt: t }));
    await register.execute(cmd({ eventId: 'a0000000-0000-4000-8000-000000000002', status: 'EN_RUTA', occurredAt: t }));

    const events = await new PgTrackingEventRepository(pool).listByShipment(TenantId.create('tenant-a'), TrackingNumber.create('GUIA-0001'));
    expect(events.map((e) => e.eventId.value.slice(-1))).toEqual(['1', '2', '3']);
  });

  it('AISLAMIENTO: las consultas de un tenant no ven datos de otro', async () => {
    const e = cmd();
    await register.execute(e);
    const tenantB = TenantId.create('tenant-b');
    expect(await new PgShipmentRepository(pool).find(tenantB, TrackingNumber.create('GUIA-0001'))).toBeNull();
    expect(await new PgTrackingEventRepository(pool).findById(tenantB, EventId.create(e.eventId))).toBeNull();
    expect(await notifications().list(tenantB, { limit: 10 })).toEqual([]);
    const [own] = await notifications().list(TenantId.create('tenant-a'), { limit: 10 });
    expect(await notifications().findById(tenantB, own!.id)).toBeNull();
  });

  it('la BD rechaza duplicados aunque el código fallara (PK + UNIQUE como última defensa)', async () => {
    const e = cmd();
    await register.execute(e);
    const [n] = await notifications().list(TenantId.create('tenant-a'), { limit: 1 });
    const duplicate = Notification.createFor({ id: new CryptoIdGenerator().uuid(), tenantId: n!.tenantId, eventId: n!.eventId, maxAttempts: 5, now: clock.now() });
    expect((await captureAsyncError(() => notifications().add(duplicate))).message).toMatch(/uq_notifications_event/);
  });

  describe('Cola de notificaciones (outbox)', () => {
    const LEASE = 30_000;

    it('SKIP LOCKED: dos workers concurrentes nunca reclaman la misma notificación', async () => {
      for (let i = 0; i < 30; i++) {
        await register.execute(cmd({ trackingNumber: `GUIA-${i}` }));
      }
      const [a, b, c] = await Promise.all([
        notifications().claimDue(clock.now(), 15, LEASE),
        notifications().claimDue(clock.now(), 15, LEASE),
        notifications().claimDue(clock.now(), 15, LEASE),
      ]);
      const ids = [...a!, ...b!, ...c!].map((n) => n.id);
      expect(new Set(ids).size).toBe(ids.length);
      expect(ids).toHaveLength(30);
      expect([...a!, ...b!, ...c!].every((n) => n.status === 'ENVIANDO' && n.attempts === 1)).toBe(true);
    });

    it('respeta next_attempt_at y recupera leases vencidos (worker caído)', async () => {
      await register.execute(cmd());
      const [claimed] = await notifications().claimDue(clock.now(), 10, LEASE);
      expect(await notifications().claimDue(clock.now(), 10, LEASE)).toEqual([]);

      clock.advance(LEASE + 1);
      const [reclaimed] = await notifications().claimDue(clock.now(), 10, LEASE);
      expect(reclaimed!.id).toBe(claimed!.id);
      expect(reclaimed!.attempts).toBe(2);
    });

    it('un resultado tardío de un lease ya re-reclamado se descarta (no pisa al worker nuevo)', async () => {
      await register.execute(cmd());
      const [stale] = await notifications().claimDue(clock.now(), 10, LEASE);
      clock.advance(LEASE + 1);
      await notifications().claimDue(clock.now(), 10, LEASE);

      stale!.recordSuccess(clock.now(), 200);
      expect(await notifications().saveAttemptResult(stale!, 1)).toBe(false);
    });

    it('programa reintento y luego marca FALLIDA; abandona el último intento con lease vencido', async () => {
      const policy = new ExponentialBackoffPolicy({ maxAttempts: 5, baseDelayMs: 2000, maxDelayMs: 60_000 }, () => 0.9999999);
      await register.execute(cmd());
      for (let attempt = 1; attempt <= 4; attempt++) {
        const [n] = await notifications().claimDue(clock.now(), 10, LEASE);
        n!.recordFailure(clock.now(), { errorCode: 'HTTP_ERROR', httpStatus: 500 }, policy);
        expect(await notifications().saveAttemptResult(n!, attempt)).toBe(true);
        clock.set(n!.snapshot().nextAttemptAt);
      }
      await notifications().claimDue(clock.now(), 10, LEASE); // 5.º intento: el worker "muere"
      clock.advance(LEASE + 1);
      expect(await notifications().claimDue(clock.now(), 10, LEASE)).toEqual([]);

      const [failed] = await notifications().list(TenantId.create('tenant-a'), { status: 'FALLIDA', limit: 10 });
      expect(failed!.snapshot()).toMatchObject({ attempts: 5, lastError: 'LEASE_EXPIRADO' });
      // El abandono deja rastro en el historial de intentos (D-5 de la auditoría QA)
      const history = await notifications().listAttempts(TenantId.create('tenant-a'), failed!.id);
      expect(history).toEqual([expect.objectContaining({ attemptNumber: 5, errorCode: 'LEASE_EXPIRADO' })]);
    });

    it('un reintento manual con lectura obsoleta NO pisa una notificación ya ENVIADA (concurrencia optimista)', async () => {
      const policy = new ExponentialBackoffPolicy({ maxAttempts: 1, baseDelayMs: 0, maxDelayMs: 0 });
      await new RegisterTrackingEvent(new PgTransactionRunner(pool), clock, new CryptoIdGenerator(), new SpyWorkSignal(), 1).execute(cmd());
      const [n] = await notifications().claimDue(clock.now(), 10, LEASE);
      n!.recordFailure(clock.now(), { errorCode: 'HTTP_ERROR', httpStatus: 500 }, policy);
      await notifications().saveAttemptResult(n!, 1); // FALLIDA

      const tenant = TenantId.create('tenant-a');
      const readA = (await notifications().findById(tenant, n!.id))!;
      const readB = (await notifications().findById(tenant, n!.id))!; // lectura que quedará obsoleta
      readA.requeue(clock.now());
      expect(await notifications().saveIfStatus(readA, 'FALLIDA')).toBe(true);
      const [claimed] = await notifications().claimDue(clock.now(), 10, LEASE);
      claimed!.recordSuccess(clock.now(), 200);
      await notifications().saveAttemptResult(claimed!, 1); // ENVIADA

      readB.requeue(clock.now());
      expect(await notifications().saveIfStatus(readB, 'FALLIDA')).toBe(false);
      expect((await notifications().findById(tenant, n!.id))!.snapshot()).toMatchObject({ status: 'ENVIADA', attempts: 1 });
    });

    it('guarda y lista el historial de intentos', async () => {
      await register.execute(cmd());
      const [n] = await notifications().claimDue(clock.now(), 10, LEASE);
      await notifications().recordAttempt({ notificationId: n!.id, attemptNumber: 1, attemptedAt: clock.now(), durationMs: 12.6, httpStatus: 503, errorCode: 'HTTP_ERROR' });
      expect(await notifications().listAttempts(TenantId.create('tenant-a'), n!.id)).toEqual([
        expect.objectContaining({ attemptNumber: 1, durationMs: 13, httpStatus: 503 }),
      ]);
      expect(await notifications().listAttempts(TenantId.create('tenant-b'), n!.id)).toEqual([]);
    });
  });

  describe('Webhooks', () => {
    it('el secreto HMAC se guarda cifrado y se recupera en claro', async () => {
      const repo = new PgWebhookSubscriptionRepository(pool, new AesGcmSecretCipher(TEST_ENCRYPTION_KEY));
      const tenantId = TenantId.create('tenant-a');
      await repo.save(WebhookSubscription.create({ tenantId, url: WebhookUrl.create('https://cliente.example.com/h'), secret: 'whsec_supersecreto', now: clock.now() }));

      const { rows } = await pool.query('SELECT secret_ciphertext FROM webhook_subscriptions');
      expect(rows[0].secret_ciphertext).not.toContain('supersecreto');
      expect((await repo.find(tenantId))!.secret).toBe('whsec_supersecreto');
    });

    it('primer PUT concurrente: solo una creación gana y revela secreto; el secreto revelado es el persistido', async () => {
      const repo = new PgWebhookSubscriptionRepository(pool, new AesGcmSecretCipher(TEST_ENCRYPTION_KEY));
      const configure = new ConfigureWebhook(repo, { assertAllowed: async () => undefined }, new RandomSecretGenerator(), clock);
      const results = await Promise.all(
        Array.from({ length: 8 }, () => configure.execute({ tenantId: 'tenant-a', url: 'https://cliente.example.com/h', rotateSecret: false })),
      );
      const created = results.filter((r) => r.created);
      expect(created).toHaveLength(1);
      expect(results.filter((r) => r.revealedSecret !== null)).toHaveLength(1);
      expect((await repo.find(TenantId.create('tenant-a')))!.secret).toBe(created[0]!.revealedSecret);
    });
  });
});
