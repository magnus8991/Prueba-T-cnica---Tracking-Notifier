import { ShipmentRepository } from '../../../application/ports/repositories';
import { Shipment } from '../../../domain/shipment/shipment';
import { ShipmentStatus } from '../../../domain/shipment/shipment-status';
import { TrackingNumber } from '../../../domain/shipment/tracking-number';
import { TenantId } from '../../../domain/tenant/tenant-id';
import { Queryable } from '../pg-pool';

interface ShipmentRow {
  tenant_id: string;
  tracking_number: string;
  current_status: ShipmentStatus;
  current_status_at: Date;
}

export class PgShipmentRepository implements ShipmentRepository {
  constructor(private readonly db: Queryable) {}

  async find(tenantId: TenantId, trackingNumber: TrackingNumber): Promise<Shipment | null> {
    const { rows } = await this.db.query<ShipmentRow>(
      `SELECT tenant_id, tracking_number, current_status, current_status_at
         FROM shipments WHERE tenant_id = $1 AND tracking_number = $2`,
      [tenantId.value, trackingNumber.value],
    );
    const row = rows[0];
    return row
      ? Shipment.restore({
          tenantId: TenantId.create(row.tenant_id),
          trackingNumber: TrackingNumber.create(row.tracking_number),
          currentStatus: row.current_status,
          currentStatusAt: row.current_status_at,
        })
      : null;
  }

  async save(shipment: Shipment): Promise<void> {
    const s = shipment.snapshot();
    await this.db.query(
      `INSERT INTO shipments (tenant_id, tracking_number, current_status, current_status_at)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (tenant_id, tracking_number)
       DO UPDATE SET current_status = EXCLUDED.current_status,
                     current_status_at = EXCLUDED.current_status_at,
                     updated_at = now()`,
      [s.tenantId.value, s.trackingNumber.value, s.currentStatus, s.currentStatusAt],
    );
  }
}
