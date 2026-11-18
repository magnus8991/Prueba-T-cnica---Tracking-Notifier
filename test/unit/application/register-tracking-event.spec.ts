import { ApplicationError } from '../../../src/application/errors';
import { RegisterTrackingEvent, RegisterTrackingEventCommand } from '../../../src/application/use-cases/register-tracking-event';
import { DomainError } from '../../../src/domain/shared/domain-error';
import { captureAsyncError } from '../../support/capture-error';
import { FixedClock, InMemoryDatabase, SequentialIds, SpyWorkSignal } from '../../support/in-memory';

describe('RegisterTrackingEvent (RF1)', () => {
  let db: InMemoryDatabase;
  let signal: SpyWorkSignal;
  let useCase: RegisterTrackingEvent;

  const command = (overrides: Partial<RegisterTrackingEventCommand> = {}): RegisterTrackingEventCommand => ({
    tenantId: 'tenant-a',
    trackingNumber: 'GUIA-0001',
    eventId: '11111111-1111-4111-8111-111111111111',
    status: 'CREADA',
    occurredAt: new Date('2026-11-01T09:00:00Z'),
    observation: null,
    ...overrides,
  });

  beforeEach(() => {
    db = new InMemoryDatabase();
    signal = new SpyWorkSignal();
    useCase = new RegisterTrackingEvent(db, new FixedClock(), new SequentialIds(), signal, 5);
  });

  it('registra el evento, actualiza la guía y encola UNA notificación en la misma transacción (outbox)', async () => {
    const result = await useCase.execute(command());

    expect(result.outcome).toBe('CREATED');
    expect(result.shipment.snapshot().currentStatus).toBe('CREADA');
    expect(db.allEvents).toHaveLength(1);
    expect(db.allNotifications).toEqual([expect.objectContaining({ status: 'PENDIENTE', attempts: 0, maxAttempts: 5 })]);
  });

  it('despierta al despachador sin esperar el envío (no bloquea la respuesta)', async () => {
    await useCase.execute(command());
    expect(signal.calls).toBe(1);
  });

  it('el mismo eventId con el mismo contenido NO duplica evento ni notificación (idempotencia)', async () => {
    await useCase.execute(command());
    const replay = await useCase.execute(command());

    expect(replay.outcome).toBe('REPLAYED');
    expect(db.allEvents).toHaveLength(1);
    expect(db.allNotifications).toHaveLength(1);
    expect(signal.calls).toBe(1);
  });

  it('el mismo eventId con distinto contenido responde conflicto y no modifica nada', async () => {
    await useCase.execute(command());
    const error = await captureAsyncError(() => useCase.execute(command({ status: 'EN_RUTA' })));

    expect(error).toBeInstanceOf(ApplicationError);
    expect(error.code).toBe('EVENT_ID_CONFLICTO');
    expect(db.allEvents).toHaveLength(1);
  });

  it('el mismo eventId reutilizado en otra guía también es conflicto', async () => {
    await useCase.execute(command());
    const error = await captureAsyncError(() => useCase.execute(command({ trackingNumber: 'GUIA-0002' })));
    expect(error.code).toBe('EVENT_ID_CONFLICTO');
  });

  it('rechaza eventos sobre una guía ENTREGADA sin persistir evento ni notificación (rollback)', async () => {
    await useCase.execute(command({ status: 'ENTREGADA' }));
    const error = await captureAsyncError(() =>
      useCase.execute(command({ eventId: '22222222-2222-4222-8222-222222222222', status: 'EN_RUTA' })),
    );

    expect(error).toBeInstanceOf(DomainError);
    expect(error.code).toBe('GUIA_EN_ESTADO_TERMINAL');
    expect(db.allEvents).toHaveLength(1);
    expect(db.allNotifications).toHaveLength(1);
  });

  it('el idempotente sobre una guía ya cerrada sigue respondiendo como repetición (no como terminal)', async () => {
    await useCase.execute(command({ status: 'DEVUELTA' }));
    await expect(useCase.execute(command({ status: 'DEVUELTA' }))).resolves.toMatchObject({ outcome: 'REPLAYED' });
  });

  it('el mismo eventId en otro tenant es un evento distinto (idempotencia por tenant)', async () => {
    await useCase.execute(command());
    const other = await useCase.execute(command({ tenantId: 'tenant-b' }));
    expect(other.outcome).toBe('CREATED');
    expect(db.allEvents).toHaveLength(2);
  });

  it('toma bloqueos en orden fijo evento → guía (evita deadlocks)', async () => {
    await useCase.execute(command());
    expect(db.locks).toEqual(['event:tenant-a:11111111-1111-4111-8111-111111111111', 'shipment:tenant-a:GUIA-0001']);
  });

  it.each([
    ['tenant inválido', { tenantId: 'x y' }, 'TENANT_INVALIDO'],
    ['guía inválida', { trackingNumber: 'G/1' }, 'NUMERO_GUIA_INVALIDO'],
    ['eventId inválido', { eventId: 'abc' }, 'EVENT_ID_INVALIDO'],
    ['estado inválido', { status: 'PERDIDA' }, 'ESTADO_INVALIDO'],
  ])('valida entradas: %s', async (_c, overrides, code) => {
    expect((await captureAsyncError(() => useCase.execute(command(overrides)))).code).toBe(code);
  });
});
