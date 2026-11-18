import { Shipment, ShipmentClosedError } from '../../../src/domain/shipment/shipment';
import { DomainError } from '../../../src/domain/shared/domain-error';
import { TrackingNumber } from '../../../src/domain/shipment/tracking-number';
import { anEvent, GUIA_1, TENANT_A, TENANT_B } from '../../support/builders';
import { captureError } from '../../support/capture-error';

describe('Shipment (agregado guía)', () => {
  const newShipment = () => Shipment.open(TENANT_A, GUIA_1);

  it('toma el estado del primer evento, sea cual sea (D2: no se exige CREADA primero)', () => {
    const shipment = newShipment();
    shipment.apply(anEvent({ status: 'EN_RUTA' }));
    expect(shipment.snapshot().currentStatus).toBe('EN_RUTA');
  });

  it('avanza al estado del evento más reciente', () => {
    const shipment = newShipment();
    shipment.apply(anEvent({ status: 'CREADA', occurredAt: '2026-11-01T10:00:00Z' }));
    shipment.apply(anEvent({ status: 'EN_RUTA', occurredAt: '2026-11-01T12:00:00Z' }));
    expect(shipment.snapshot()).toMatchObject({ currentStatus: 'EN_RUTA', currentStatusAt: new Date('2026-11-01T12:00:00Z') });
  });

  it('permite repetir un estado no terminal (varios escaneos EN_RUTA)', () => {
    const shipment = newShipment();
    shipment.apply(anEvent({ status: 'EN_RUTA', occurredAt: '2026-11-01T10:00:00Z' }));
    expect(() => shipment.apply(anEvent({ status: 'EN_RUTA', occurredAt: '2026-11-01T11:00:00Z' }))).not.toThrow();
  });

  it.each(['ENTREGADA', 'DEVUELTA'] as const)('una guía %s ya no cambia de estado (regla terminal)', (terminal) => {
    const shipment = newShipment();
    shipment.apply(anEvent({ status: 'EN_RUTA', occurredAt: '2026-11-01T10:00:00Z' }));
    shipment.apply(anEvent({ status: terminal, occurredAt: '2026-11-01T11:00:00Z' }));

    expect(shipment.isClosed).toBe(true);
    for (const next of ['CREADA', 'EN_RUTA', 'ENTREGADA', 'DEVUELTA'] as const) {
      expect(() => shipment.apply(anEvent({ status: next, occurredAt: '2026-11-02T10:00:00Z' }))).toThrow(ShipmentClosedError);
    }
    expect(shipment.snapshot().currentStatus).toBe(terminal);
  });

  it('el error terminal expone el código estable GUIA_EN_ESTADO_TERMINAL', () => {
    const shipment = newShipment();
    shipment.apply(anEvent({ status: 'ENTREGADA' }));
    const error = captureError(() => shipment.apply(anEvent({ status: 'EN_RUTA' })));
    expect(error).toBeInstanceOf(DomainError);
    expect(error.code).toBe('GUIA_EN_ESTADO_TERMINAL');
  });

  it('un evento atrasado (fuera de orden) no reemplaza el estado actual (D4)', () => {
    const shipment = newShipment();
    shipment.apply(anEvent({ status: 'EN_RUTA', occurredAt: '2026-11-01T12:00:00Z' }));
    shipment.apply(anEvent({ status: 'CREADA', occurredAt: '2026-11-01T08:00:00Z' }));
    expect(shipment.snapshot().currentStatus).toBe('EN_RUTA');
  });

  it('un evento terminal cierra la guía aunque llegue con fecha anterior (D4)', () => {
    const shipment = newShipment();
    shipment.apply(anEvent({ status: 'EN_RUTA', occurredAt: '2026-11-01T12:00:00Z' }));
    shipment.apply(anEvent({ status: 'ENTREGADA', occurredAt: '2026-11-01T11:00:00Z' }));
    expect(shipment.snapshot().currentStatus).toBe('ENTREGADA');
    expect(shipment.isClosed).toBe(true);
  });

  it('rechaza eventos de otro tenant o de otra guía (aislamiento)', () => {
    const shipment = newShipment();
    expect(captureError(() => shipment.apply(anEvent({ tenantId: TENANT_B }))).code).toBe('EVENTO_NO_PERTENECE_A_GUIA');
    expect(captureError(() => shipment.apply(anEvent({ trackingNumber: TrackingNumber.create('OTRA') }))).code).toBe(
      'EVENTO_NO_PERTENECE_A_GUIA',
    );
  });

  it('no permite persistir una guía sin eventos (invariante)', () => {
    expect(() => newShipment().snapshot()).toThrow();
  });

  it('restore reconstruye el estado persistido', () => {
    const restored = Shipment.restore({ tenantId: TENANT_A, trackingNumber: GUIA_1, currentStatus: 'DEVUELTA', currentStatusAt: new Date() });
    expect(restored.isClosed).toBe(true);
  });
});
