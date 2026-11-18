import { TrackingEventRepository } from '../../../application/ports/repositories';
import { EventId } from '../../../domain/shipment/event-id';
import { ShipmentStatus } from '../../../domain/shipment/shipment-status';
import { TrackingEvent } from '../../../domain/shipment/tracking-event';
import { TrackingNumber } from '../../../domain/shipment/tracking-number';
import { TenantId } from '../../../domain/tenant/tenant-id';
import { Queryable } from '../pg-pool';

interface EventRow {
  tenant_id: string;
  event_id: string;
  tracking_number: string;
  status: ShipmentStatus;
  occurred_at: Date;
  observation: string | null;
  received_at: Date;
}

const COLUMNS = 'tenant_id, event_id, tracking_number, status, occurred_at, observation, received_at';

function toDomain(row: EventRow): TrackingEvent {
  return TrackingEvent.create({
    tenantId: TenantId.create(row.tenant_id),
    eventId: EventId.create(row.event_id),
    trackingNumber: TrackingNumber.create(row.tracking_number),
    status: row.status,
    occurredAt: row.occurred_at,
    observation: row.observation,
    receivedAt: row.received_at,
  });
}

export class PgTrackingEventRepository implements TrackingEventRepository {
  constructor(private readonly db: Queryable) {}

  async findById(tenantId: TenantId, eventId: EventId): Promise<TrackingEvent | null> {
    const { rows } = await this.db.query<EventRow>(`SELECT ${COLUMNS} FROM tracking_events WHERE tenant_id = $1 AND event_id = $2`, [
      tenantId.value,
      eventId.value,
    ]);
    return rows[0] ? toDomain(rows[0]) : null;
  }

  async add(event: TrackingEvent): Promise<void> {
    await this.db.query(
      `INSERT INTO tracking_events (tenant_id, event_id, tracking_number, status, occurred_at, observation, received_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [event.tenantId.value, event.eventId.value, event.trackingNumber.value, event.status, event.occurredAt, event.observation, event.receivedAt],
    );
  }

  async listByShipment(tenantId: TenantId, trackingNumber: TrackingNumber): Promise<TrackingEvent[]> {
    const { rows } = await this.db.query<EventRow>(
      `SELECT ${COLUMNS} FROM tracking_events
        WHERE tenant_id = $1 AND tracking_number = $2
        ORDER BY occurred_at ASC, received_seq ASC`,
      [tenantId.value, trackingNumber.value],
    );
    return rows.map(toDomain);
  }
}
