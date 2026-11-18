import { ShipmentSnapshot } from '../../domain/shipment/shipment';
import { TrackingEvent } from '../../domain/shipment/tracking-event';
import { TrackingNumber } from '../../domain/shipment/tracking-number';
import { TenantId } from '../../domain/tenant/tenant-id';
import { NotFoundError } from '../errors';
import { ShipmentRepository, TrackingEventRepository } from '../ports/repositories';

export interface ShipmentHistory {
  shipment: ShipmentSnapshot;
  events: TrackingEvent[];
}

/** RF2: estado actual + eventos en orden cronológico. Una guía de otro tenant es indistinguible de una inexistente. */
export class GetShipmentHistory {
  constructor(
    private readonly shipments: ShipmentRepository,
    private readonly events: TrackingEventRepository,
  ) {}

  async execute(query: { tenantId: string; trackingNumber: string }): Promise<ShipmentHistory> {
    const tenantId = TenantId.create(query.tenantId);
    const trackingNumber = TrackingNumber.create(query.trackingNumber);
    const shipment = await this.shipments.find(tenantId, trackingNumber);
    if (!shipment) {
      throw new NotFoundError('Guía no encontrada');
    }
    const events = await this.events.listByShipment(tenantId, trackingNumber);
    return { shipment: shipment.snapshot(), events };
  }
}
