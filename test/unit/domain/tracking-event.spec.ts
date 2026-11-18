import { EventId } from '../../../src/domain/shipment/event-id';
import { TrackingEvent } from '../../../src/domain/shipment/tracking-event';
import { anEvent, GUIA_1, TENANT_A } from '../../support/builders';
import { captureError } from '../../support/capture-error';

describe('TrackingEvent', () => {
  const ID = '11111111-1111-4111-8111-111111111111';

  it('considera idéntico un reintento con el mismo contenido (idempotencia)', () => {
    expect(anEvent({ eventId: ID, observation: 'x' }).hasSameContentAs(anEvent({ eventId: ID, observation: 'x' }))).toBe(true);
  });

  it('compara fechas por instante, no por formato (misma hora en otra zona horaria)', () => {
    const utc = anEvent({ eventId: ID, occurredAt: '2026-11-01T15:00:00Z' });
    const bogota = anEvent({ eventId: ID, occurredAt: '2026-11-01T10:00:00-05:00' });
    expect(utc.hasSameContentAs(bogota)).toBe(true);
  });

  it.each([
    ['estado', { status: 'EN_RUTA' as const }],
    ['fecha', { occurredAt: '2026-11-02T10:00:00Z' }],
    ['observación', { observation: 'distinta' }],
  ])('detecta contenido distinto con el mismo eventId (%s)', (_c, change) => {
    expect(anEvent({ eventId: ID }).hasSameContentAs(anEvent({ eventId: ID, ...change }))).toBe(false);
  });

  it('normaliza la observación: recorta espacios y la vacía pasa a null', () => {
    expect(anEvent({ observation: '  dejado en portería  ' }).observation).toBe('dejado en portería');
    expect(anEvent({ observation: '   ' }).observation).toBeNull();
  });

  it('rechaza observación de más de 500 caracteres', () => {
    expect(captureError(() => anEvent({ observation: 'x'.repeat(501) })).code).toBe('OBSERVACION_INVALIDA');
  });

  it('rechaza fechas inválidas', () => {
    const error = captureError(() =>
      TrackingEvent.create({
        tenantId: TENANT_A,
        eventId: EventId.create(ID),
        trackingNumber: GUIA_1,
        status: 'CREADA',
        occurredAt: new Date('no-es-fecha'),
        observation: null,
        receivedAt: new Date(),
      }),
    );
    expect(error.code).toBe('FECHA_EVENTO_INVALIDA');
  });
});
