import { DeliveryResult } from '../../../src/application/ports/webhook-sender';
import { DispatchDueNotifications, toWebhookPayload } from '../../../src/application/use-cases/dispatch-due-notifications';
import { RetryNotification } from '../../../src/application/use-cases/notification-queries';
import { RegisterTrackingEvent } from '../../../src/application/use-cases/register-tracking-event';
import { ExponentialBackoffPolicy } from '../../../src/domain/notification/retry-policy';
import { TenantId } from '../../../src/domain/tenant/tenant-id';
import { WebhookSubscription } from '../../../src/domain/webhook/webhook-subscription';
import { WebhookUrl } from '../../../src/domain/webhook/webhook-url';
import {
  FixedClock,
  InMemoryDatabase,
  InMemorySubscriptions,
  ScriptedSender,
  SequentialIds,
  SilentLogger,
  SpyMetrics,
  SpyWorkSignal,
} from '../../support/in-memory';

describe('DispatchDueNotifications (RF4)', () => {
  const EVENT_ID = '11111111-1111-4111-8111-111111111111';
  let db: InMemoryDatabase;
  let subs: InMemorySubscriptions;
  let clock: FixedClock;
  let metrics: SpyMetrics;
  let logger: SilentLogger;
  const policy = new ExponentialBackoffPolicy({ maxAttempts: 5, baseDelayMs: 2000, maxDelayMs: 60_000 }, () => 0.9999999);

  const dispatcherWith = (sender: ScriptedSender) =>
    new DispatchDueNotifications(db.notifications, db.events, subs, sender, policy, clock, logger, metrics, { batchSize: 10, leaseMs: 30_000 });

  beforeEach(async () => {
    db = new InMemoryDatabase();
    subs = new InMemorySubscriptions();
    clock = new FixedClock();
    metrics = new SpyMetrics();
    logger = new SilentLogger();
    const tenantId = TenantId.create('tenant-a');
    await subs.save(WebhookSubscription.create({ tenantId, url: WebhookUrl.create('https://cliente.example.com/hook'), secret: 'whsec_x', now: clock.now() }));
    await new RegisterTrackingEvent(db, clock, new SequentialIds(), new SpyWorkSignal(), 5).execute({
      tenantId: 'tenant-a',
      trackingNumber: 'GUIA-0001',
      eventId: EVENT_ID,
      status: 'EN_RUTA',
      occurredAt: new Date('2026-11-01T09:00:00Z'),
      observation: 'Dato ficticio',
    });
  });

  it('envía el evento al webhook del tenant y marca ENVIADA', async () => {
    const sender = new ScriptedSender();
    expect(await dispatcherWith(sender).execute()).toBe(1);

    expect(sender.deliveries).toEqual([
      expect.objectContaining({ url: 'https://cliente.example.com/hook', secret: 'whsec_x', messageId: EVENT_ID, attempt: 1 }),
    ]);
    expect(sender.deliveries[0]!.payload).toMatchObject({ type: 'guia.estado_actualizado', eventId: EVENT_ID, numeroGuia: 'GUIA-0001', estado: 'EN_RUTA' });
    expect(db.allNotifications[0]).toMatchObject({ status: 'ENVIADA', attempts: 1, lastHttpStatus: 200 });
    expect(db.allAttempts).toEqual([expect.objectContaining({ attemptNumber: 1, httpStatus: 200, errorCode: null })]);
    expect(metrics.outcomes).toEqual(['ENVIADA']);
  });

  it('no reenvía una notificación ya entregada', async () => {
    const sender = new ScriptedSender();
    await dispatcherWith(sender).execute();
    clock.advance(3_600_000);
    expect(await dispatcherWith(sender).execute()).toBe(0);
    expect(sender.deliveries).toHaveLength(1);
  });

  it('timeout/5xx: reintenta con espera creciente hasta 5 intentos y luego queda FALLIDA', async () => {
    const results: DeliveryResult[] = [
      { ok: false, errorCode: 'TIMEOUT', httpStatus: null, durationMs: 5000 },
      { ok: false, errorCode: 'HTTP_ERROR', httpStatus: 500, durationMs: 10 },
    ];
    let i = 0;
    const sender = new ScriptedSender(() => results[i++ % 2]!);
    const dispatcher = dispatcherWith(sender);
    const waits: number[] = [];

    for (let attempt = 1; attempt <= 5; attempt++) {
      expect(await dispatcher.execute()).toBe(1);
      const n = db.allNotifications[0]!;
      if (n.status === 'PENDIENTE') {
        // Antes de la espera no hay trabajo
        expect(await dispatcher.execute()).toBe(0);
        waits.push(n.nextAttemptAt.getTime() - clock.now().getTime());
        clock.set(n.nextAttemptAt);
      }
    }

    expect(waits).toEqual([2000, 4000, 8000, 16000]);
    expect(sender.deliveries.map((d) => d.attempt)).toEqual([1, 2, 3, 4, 5]);
    expect(db.allNotifications[0]).toMatchObject({ status: 'FALLIDA', attempts: 5, lastError: 'TIMEOUT' });
    expect(db.allAttempts).toHaveLength(5);
    expect(metrics.outcomes).toEqual(['REINTENTO_PROGRAMADO', 'REINTENTO_PROGRAMADO', 'REINTENTO_PROGRAMADO', 'REINTENTO_PROGRAMADO', 'FALLIDA']);
    expect(logger.entries.some((e) => e.level === 'warn')).toBe(true);

    clock.advance(10 ** 9);
    expect(await dispatcher.execute()).toBe(0);
  });

  it('una FALLIDA reintentada manualmente vuelve a entregarse', async () => {
    const failing = dispatcherWith(new ScriptedSender(() => ({ ok: false, errorCode: 'HTTP_ERROR', httpStatus: 503, durationMs: 1 })));
    for (let k = 0; k < 5; k++) {
      await failing.execute();
      clock.advance(60_000);
    }
    const id = db.allNotifications[0]!.id;
    await new RetryNotification(db.notifications, clock, new SpyWorkSignal()).execute({ tenantId: 'tenant-a', id });

    const ok = new ScriptedSender();
    await dispatcherWith(ok).execute();
    expect(ok.deliveries[0]!.attempt).toBe(1);
    expect(db.allNotifications[0]).toMatchObject({ status: 'ENVIADA' });
  });

  it('sin webhook configurado cuenta como intento fallido (no se pierde: queda reintentable)', async () => {
    subs = new InMemorySubscriptions();
    const sender = new ScriptedSender();
    await dispatcherWith(sender).execute();
    expect(sender.deliveries).toHaveLength(0);
    expect(db.allNotifications[0]).toMatchObject({ status: 'PENDIENTE', lastError: 'WEBHOOK_NO_CONFIGURADO', attempts: 1 });
  });

  it('nunca registra en logs la observación (dato potencialmente personal)', async () => {
    await dispatcherWith(new ScriptedSender()).execute();
    expect(JSON.stringify(logger.entries)).not.toContain('Dato ficticio');
  });

  it('el payload del webhook serializa fechas en ISO 8601 UTC', () => {
    const [event] = db.allEvents;
    expect(toWebhookPayload(event!)).toMatchObject({ fechaEvento: '2026-11-01T09:00:00.000Z', observacion: 'Dato ficticio' });
  });
});
