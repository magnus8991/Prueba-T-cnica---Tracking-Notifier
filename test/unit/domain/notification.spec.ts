import { Notification } from '../../../src/domain/notification/notification';
import { ExponentialBackoffPolicy } from '../../../src/domain/notification/retry-policy';
import { EventId } from '../../../src/domain/shipment/event-id';
import { TENANT_A } from '../../support/builders';
import { captureError } from '../../support/capture-error';

describe('Notification (outbox + reintentos)', () => {
  const T0 = new Date('2026-11-01T10:00:00Z');
  const LEASE = 30_000;
  const policy = new ExponentialBackoffPolicy({ maxAttempts: 5, baseDelayMs: 2000, maxDelayMs: 60_000 }, () => 0.9999999);
  const failure = { errorCode: 'TIMEOUT', httpStatus: null };
  const at = (ms: number) => new Date(T0.getTime() + ms);

  const newNotification = () =>
    Notification.createFor({ id: 'n-1', tenantId: TENANT_A, eventId: EventId.create('11111111-1111-4111-8111-111111111111'), maxAttempts: 5, now: T0 });

  it('nace PENDIENTE y vencida inmediatamente', () => {
    const n = newNotification();
    expect(n.status).toBe('PENDIENTE');
    expect(n.isDue(T0)).toBe(true);
  });

  it('al iniciar un intento pasa a ENVIANDO, cuenta el intento y toma un lease', () => {
    const n = newNotification();
    n.startAttempt(T0, LEASE);
    expect(n.snapshot()).toMatchObject({ status: 'ENVIANDO', attempts: 1, lockedUntil: at(LEASE) });
    expect(n.isDue(at(1000))).toBe(false);
  });

  it('un lease vencido la vuelve reclamable (recuperación si el worker cae)', () => {
    const n = newNotification();
    n.startAttempt(T0, LEASE);
    expect(n.isDue(at(LEASE + 1))).toBe(true);
  });

  it('2xx la marca ENVIADA', () => {
    const n = newNotification();
    n.startAttempt(T0, LEASE);
    n.recordSuccess(at(100), 200);
    expect(n.snapshot()).toMatchObject({ status: 'ENVIADA', lastHttpStatus: 200, deliveredAt: at(100), lockedUntil: null });
    expect(n.isDue(at(999_999))).toBe(false);
  });

  it('reintenta con espera creciente y queda FALLIDA tras el 5.º intento', () => {
    const n = newNotification();
    let now = T0;
    const waits: number[] = [];
    for (let attempt = 1; attempt <= 5; attempt++) {
      n.startAttempt(now, LEASE);
      n.recordFailure(now, failure, policy);
      if (n.status === 'PENDIENTE') {
        const next = n.snapshot().nextAttemptAt;
        waits.push(next.getTime() - now.getTime());
        now = next;
      }
    }
    expect(waits).toEqual([2000, 4000, 8000, 16000]);
    expect(n.snapshot()).toMatchObject({ status: 'FALLIDA', attempts: 5, lastError: 'TIMEOUT' });
    expect(n.snapshot().failedAt).toEqual(now);
    expect(n.isDue(at(10 ** 9))).toBe(false);
  });

  it('no permite registrar resultados si no está ENVIANDO', () => {
    const n = newNotification();
    expect(captureError(() => n.recordSuccess(T0, 200)).code).toBe('TRANSICION_NOTIFICACION_INVALIDA');
    expect(captureError(() => n.recordFailure(T0, failure, policy)).code).toBe('TRANSICION_NOTIFICACION_INVALIDA');
  });

  it('no permite iniciar un intento antes de tiempo', () => {
    const n = newNotification();
    n.startAttempt(T0, LEASE);
    n.recordFailure(T0, failure, policy);
    expect(captureError(() => n.startAttempt(T0, LEASE)).code).toBe('TRANSICION_NOTIFICACION_INVALIDA');
  });

  it('una FALLIDA se puede reencolar manualmente con el contador reiniciado', () => {
    const n = newNotification();
    for (let i = 0; i < 5; i++) {
      n.startAttempt(at(10 ** 8 * i), LEASE);
      n.recordFailure(at(10 ** 8 * i), failure, policy);
    }
    n.requeue(at(10 ** 9));
    expect(n.snapshot()).toMatchObject({ status: 'PENDIENTE', attempts: 0, failedAt: null, nextAttemptAt: at(10 ** 9) });
  });

  it('solo FALLIDA es reencolable', () => {
    expect(captureError(() => newNotification().requeue(T0)).code).toBe('NOTIFICACION_NO_REINTENTABLE');
  });
});
