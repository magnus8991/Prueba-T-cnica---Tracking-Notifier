import { Notification, NotificationStatus } from '../../domain/notification/notification';
import { EventId } from '../../domain/shipment/event-id';
import { Shipment } from '../../domain/shipment/shipment';
import { TrackingEvent } from '../../domain/shipment/tracking-event';
import { TrackingNumber } from '../../domain/shipment/tracking-number';
import { TenantId } from '../../domain/tenant/tenant-id';
import { WebhookSubscription } from '../../domain/webhook/webhook-subscription';

// Puertos de salida de persistencia. TODOS reciben TenantId cuando leen datos de un
// tenant: el aislamiento es parte del contrato, no un detalle del adaptador.

export interface ShipmentRepository {
  find(tenantId: TenantId, trackingNumber: TrackingNumber): Promise<Shipment | null>;
  save(shipment: Shipment): Promise<void>;
}

export interface TrackingEventRepository {
  findById(tenantId: TenantId, eventId: EventId): Promise<TrackingEvent | null>;
  add(event: TrackingEvent): Promise<void>;
  /** Eventos de la guía en orden cronológico (fechaEvento, luego orden de llegada). */
  listByShipment(tenantId: TenantId, trackingNumber: TrackingNumber): Promise<TrackingEvent[]>;
}

export interface NotificationAttempt {
  notificationId: string;
  attemptNumber: number;
  attemptedAt: Date;
  durationMs: number;
  httpStatus: number | null;
  errorCode: string | null;
}

export interface NotificationQuery {
  status?: NotificationStatus;
  limit: number;
}

export interface NotificationRepository {
  add(notification: Notification): Promise<void>;
  findById(tenantId: TenantId, id: string): Promise<Notification | null>;
  list(tenantId: TenantId, query: NotificationQuery): Promise<Notification[]>;
  /**
   * Guarda el resultado de un intento solo si la fila sigue en el estado que el worker
   * reclamó (protección ante un lease vencido y re-reclamado). Devuelve false si se descartó.
   */
  saveAttemptResult(notification: Notification, expectedAttempts: number): Promise<boolean>;
  /** Persiste un cambio administrativo (p.ej. requeue). */
  save(notification: Notification): Promise<void>;
  /**
   * Reclama atómicamente hasta `limit` notificaciones vencidas (cross-tenant: uso exclusivo
   * del worker), las marca ENVIANDO con un lease y cuenta el intento.
   */
  claimDue(now: Date, limit: number, leaseMs: number): Promise<Notification[]>;
  recordAttempt(attempt: NotificationAttempt): Promise<void>;
  listAttempts(tenantId: TenantId, notificationId: string): Promise<NotificationAttempt[]>;
}

export interface WebhookSubscriptionRepository {
  find(tenantId: TenantId): Promise<WebhookSubscription | null>;
  save(subscription: WebhookSubscription): Promise<void>;
}
