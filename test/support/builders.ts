import { EventId } from '../../src/domain/shipment/event-id';
import { ShipmentStatus } from '../../src/domain/shipment/shipment-status';
import { TrackingEvent } from '../../src/domain/shipment/tracking-event';
import { TrackingNumber } from '../../src/domain/shipment/tracking-number';
import { TenantId } from '../../src/domain/tenant/tenant-id';

/** Datos ficticios para pruebas. */
export const TENANT_A = TenantId.create('tenant-a');
export const TENANT_B = TenantId.create('tenant-b');
export const GUIA_1 = TrackingNumber.create('GUIA-0001');

let counter = 0;
export function fakeUuid(): string {
  counter += 1;
  return `00000000-0000-4000-8000-${counter.toString().padStart(12, '0')}`;
}

export function anEvent(overrides: Partial<{
  tenantId: TenantId;
  eventId: string;
  trackingNumber: TrackingNumber;
  status: ShipmentStatus;
  occurredAt: string;
  observation: string | null;
}> = {}): TrackingEvent {
  return TrackingEvent.create({
    tenantId: overrides.tenantId ?? TENANT_A,
    eventId: EventId.create(overrides.eventId ?? fakeUuid()),
    trackingNumber: overrides.trackingNumber ?? GUIA_1,
    status: overrides.status ?? 'CREADA',
    occurredAt: new Date(overrides.occurredAt ?? '2026-11-01T10:00:00Z'),
    observation: overrides.observation ?? null,
    receivedAt: new Date('2026-11-01T10:00:01Z'),
  });
}
