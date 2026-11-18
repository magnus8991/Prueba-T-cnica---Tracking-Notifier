import { DomainError } from '../shared/domain-error';
import { TenantId } from '../tenant/tenant-id';
import { isTerminalStatus, ShipmentStatus } from './shipment-status';
import { TrackingEvent } from './tracking-event';
import { TrackingNumber } from './tracking-number';

export interface ShipmentSnapshot {
  tenantId: TenantId;
  trackingNumber: TrackingNumber;
  currentStatus: ShipmentStatus;
  currentStatusAt: Date;
}

export class ShipmentClosedError extends DomainError {
  constructor(
    readonly trackingNumber: string,
    readonly status: ShipmentStatus,
  ) {
    super('GUIA_EN_ESTADO_TERMINAL', `La guía ${trackingNumber} está ${status} y no admite más cambios de estado`);
  }
}

/**
 * Agregado raíz: una guía de envío de un tenant.
 *
 * Reglas:
 *  - ENTREGADA y DEVUELTA son terminales: la guía ya no acepta eventos.
 *  - Con eventos fuera de orden, el estado actual es el del evento con fechaEvento
 *    más reciente; un evento terminal siempre cierra la guía.
 */
export class Shipment {
  private constructor(
    readonly tenantId: TenantId,
    readonly trackingNumber: TrackingNumber,
    private status: ShipmentStatus | null,
    private statusAt: Date | null,
  ) {}

  /** Guía nueva, aún sin eventos. */
  static open(tenantId: TenantId, trackingNumber: TrackingNumber): Shipment {
    return new Shipment(tenantId, trackingNumber, null, null);
  }

  static restore(snapshot: ShipmentSnapshot): Shipment {
    return new Shipment(snapshot.tenantId, snapshot.trackingNumber, snapshot.currentStatus, snapshot.currentStatusAt);
  }

  get isClosed(): boolean {
    return this.status !== null && isTerminalStatus(this.status);
  }

  apply(event: TrackingEvent): void {
    if (!event.tenantId.equals(this.tenantId) || !event.trackingNumber.equals(this.trackingNumber)) {
      throw new DomainError('EVENTO_NO_PERTENECE_A_GUIA', 'El evento no pertenece a esta guía');
    }
    if (this.status !== null && isTerminalStatus(this.status)) {
      throw new ShipmentClosedError(this.trackingNumber.value, this.status);
    }
    const isFirstEvent = this.status === null || this.statusAt === null;
    const isMoreRecent = !isFirstEvent && event.occurredAt.getTime() >= (this.statusAt as Date).getTime();
    if (isFirstEvent || isMoreRecent || isTerminalStatus(event.status)) {
      this.status = event.status;
      this.statusAt = event.occurredAt;
    }
  }

  snapshot(): ShipmentSnapshot {
    if (this.status === null || this.statusAt === null) {
      throw new Error('Invariante violada: una guía sin eventos no puede persistirse');
    }
    return {
      tenantId: this.tenantId,
      trackingNumber: this.trackingNumber,
      currentStatus: this.status,
      currentStatusAt: this.statusAt,
    };
  }
}
