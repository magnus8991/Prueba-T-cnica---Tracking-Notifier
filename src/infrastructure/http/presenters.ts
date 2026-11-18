import { NotificationAttempt } from '../../application/ports/repositories';
import { ShipmentHistory } from '../../application/use-cases/get-shipment-history';
import { Notification } from '../../domain/notification/notification';
import { ShipmentSnapshot } from '../../domain/shipment/shipment';
import { TrackingEvent } from '../../domain/shipment/tracking-event';
import { WebhookSubscription } from '../../domain/webhook/webhook-subscription';

/** Mappers dominio → contrato HTTP (los nombres públicos siguen el enunciado, en español). */

export function presentEvent(event: TrackingEvent) {
  return {
    eventId: event.eventId.value,
    numeroGuia: event.trackingNumber.value,
    estado: event.status,
    fechaEvento: event.occurredAt.toISOString(),
    observacion: event.observation,
    recibidoEn: event.receivedAt.toISOString(),
  };
}

export function presentRegisteredEvent(event: TrackingEvent, shipment: ShipmentSnapshot) {
  return { ...presentEvent(event), estadoActualGuia: shipment.currentStatus };
}

export function presentHistory(history: ShipmentHistory) {
  return {
    numeroGuia: history.shipment.trackingNumber.value,
    estadoActual: history.shipment.currentStatus,
    fechaEstadoActual: history.shipment.currentStatusAt.toISOString(),
    eventos: history.events.map(presentEvent),
  };
}

export function presentWebhook(subscription: WebhookSubscription, revealedSecret: string | null = null) {
  return {
    url: subscription.url.value,
    ...(revealedSecret ? { secreto: revealedSecret } : {}),
    algoritmoFirma: 'HMAC-SHA256 (Standard Webhooks v1)',
    creadoEn: subscription.createdAt.toISOString(),
    actualizadoEn: subscription.updatedAt.toISOString(),
  };
}

const iso = (d: Date | null) => (d ? d.toISOString() : null);

export function presentNotification(notification: Notification) {
  const n = notification.snapshot();
  return {
    id: n.id,
    eventId: n.eventId.value,
    estado: n.status,
    intentos: n.attempts,
    maxIntentos: n.maxAttempts,
    proximoIntentoEn: n.status === 'PENDIENTE' ? iso(n.nextAttemptAt) : null,
    ultimoError: n.lastError,
    ultimoHttpStatus: n.lastHttpStatus,
    entregadaEn: iso(n.deliveredAt),
    fallidaEn: iso(n.failedAt),
    creadaEn: iso(n.createdAt),
    actualizadaEn: iso(n.updatedAt),
  };
}

export function presentAttempt(attempt: NotificationAttempt) {
  return {
    intento: attempt.attemptNumber,
    fecha: attempt.attemptedAt.toISOString(),
    duracionMs: attempt.durationMs,
    httpStatus: attempt.httpStatus,
    error: attempt.errorCode,
  };
}
