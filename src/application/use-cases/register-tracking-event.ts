import { Notification } from '../../domain/notification/notification';
import { EventId } from '../../domain/shipment/event-id';
import { Shipment } from '../../domain/shipment/shipment';
import { parseShipmentStatus } from '../../domain/shipment/shipment-status';
import { TrackingEvent } from '../../domain/shipment/tracking-event';
import { TrackingNumber } from '../../domain/shipment/tracking-number';
import { TenantId } from '../../domain/tenant/tenant-id';
import { ApplicationError } from '../errors';
import { Clock, IdGenerator, WorkSignal } from '../ports/system';
import { TransactionRunner } from '../ports/transaction-runner';

export interface RegisterTrackingEventCommand {
  tenantId: string;
  trackingNumber: string;
  eventId: string;
  status: string;
  occurredAt: Date;
  observation: string | null;
}

export interface RegisterTrackingEventResult {
  /** CREATED: evento nuevo. REPLAYED: reintento idempotente de un evento ya registrado. */
  outcome: 'CREATED' | 'REPLAYED';
  event: TrackingEvent;
  shipment: Shipment;
}

/**
 * RF1 + RF4 (encolado). En UNA transacción: valida reglas de la guía, guarda el
 * evento y crea la notificación (Transactional Outbox). El envío al webhook ocurre
 * después, en el despachador, por lo que la respuesta nunca espera al cliente.
 */
export class RegisterTrackingEvent {
  constructor(
    private readonly tx: TransactionRunner,
    private readonly clock: Clock,
    private readonly ids: IdGenerator,
    private readonly workSignal: WorkSignal,
    private readonly maxDeliveryAttempts: number,
  ) {}

  async execute(command: RegisterTrackingEventCommand): Promise<RegisterTrackingEventResult> {
    const now = this.clock.now();
    const tenantId = TenantId.create(command.tenantId);
    const trackingNumber = TrackingNumber.create(command.trackingNumber);
    const incoming = TrackingEvent.create({
      tenantId,
      eventId: EventId.create(command.eventId),
      trackingNumber,
      status: parseShipmentStatus(command.status),
      occurredAt: command.occurredAt,
      observation: command.observation,
      receivedAt: now,
    });

    const result = await this.tx.run(async (tx) => {
      // Orden fijo de bloqueos (evento → guía) para evitar deadlocks entre peticiones concurrentes.
      await tx.lock(`event:${tenantId.value}:${incoming.eventId.value}`);
      await tx.lock(`shipment:${tenantId.value}:${trackingNumber.value}`);

      const existing = await tx.events.findById(tenantId, incoming.eventId);
      if (existing) {
        if (!existing.hasSameContentAs(incoming)) {
          throw new ApplicationError('EVENT_ID_CONFLICTO', 'El eventId ya fue registrado con un contenido distinto');
        }
        const shipment = await tx.shipments.find(tenantId, existing.trackingNumber);
        return { outcome: 'REPLAYED' as const, event: existing, shipment: shipment! };
      }

      const shipment = (await tx.shipments.find(tenantId, trackingNumber)) ?? Shipment.open(tenantId, trackingNumber);
      shipment.apply(incoming); // lanza GUIA_EN_ESTADO_TERMINAL si corresponde

      await tx.shipments.save(shipment);
      await tx.events.add(incoming);
      await tx.notifications.add(
        Notification.createFor({ id: this.ids.uuid(), tenantId, eventId: incoming.eventId, maxAttempts: this.maxDeliveryAttempts, now }),
      );
      return { outcome: 'CREATED' as const, event: incoming, shipment };
    });

    if (result.outcome === 'CREATED') {
      this.workSignal.notify();
    }
    return result;
  }
}
