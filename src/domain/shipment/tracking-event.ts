import { DomainError } from '../shared/domain-error';
import { TenantId } from '../tenant/tenant-id';
import { EventId } from './event-id';
import { ShipmentStatus } from './shipment-status';
import { TrackingNumber } from './tracking-number';

export const MAX_OBSERVATION_LENGTH = 500;

export interface TrackingEventProps {
  tenantId: TenantId;
  eventId: EventId;
  trackingNumber: TrackingNumber;
  status: ShipmentStatus;
  occurredAt: Date;
  observation: string | null;
  receivedAt: Date;
}

/** Evento inmutable de cambio de estado de una guía. */
export class TrackingEvent {
  private constructor(private readonly props: TrackingEventProps) {}

  static create(props: TrackingEventProps): TrackingEvent {
    if (!(props.occurredAt instanceof Date) || Number.isNaN(props.occurredAt.getTime())) {
      throw new DomainError('FECHA_EVENTO_INVALIDA', 'fechaEvento debe ser una fecha ISO 8601 válida');
    }
    const observation = props.observation === null ? null : props.observation.trim();
    if (observation !== null && observation.length > MAX_OBSERVATION_LENGTH) {
      throw new DomainError('OBSERVACION_INVALIDA', `observacion admite máximo ${MAX_OBSERVATION_LENGTH} caracteres`);
    }
    return new TrackingEvent({ ...props, observation: observation === '' ? null : observation });
  }

  get tenantId(): TenantId {
    return this.props.tenantId;
  }
  get eventId(): EventId {
    return this.props.eventId;
  }
  get trackingNumber(): TrackingNumber {
    return this.props.trackingNumber;
  }
  get status(): ShipmentStatus {
    return this.props.status;
  }
  get occurredAt(): Date {
    return this.props.occurredAt;
  }
  get observation(): string | null {
    return this.props.observation;
  }
  get receivedAt(): Date {
    return this.props.receivedAt;
  }

  /**
   * Dos eventos con el mismo eventId son "el mismo" (reintento idempotente) solo
   * si su contenido de negocio coincide. receivedAt se ignora a propósito.
   */
  hasSameContentAs(other: TrackingEvent): boolean {
    return (
      this.tenantId.equals(other.tenantId) &&
      this.eventId.equals(other.eventId) &&
      this.trackingNumber.equals(other.trackingNumber) &&
      this.status === other.status &&
      this.occurredAt.getTime() === other.occurredAt.getTime() &&
      this.observation === other.observation
    );
  }
}
