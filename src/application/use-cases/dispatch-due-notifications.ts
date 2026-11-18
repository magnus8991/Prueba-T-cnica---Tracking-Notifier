import { Notification } from '../../domain/notification/notification';
import { RetryPolicy } from '../../domain/notification/retry-policy';
import { TrackingEvent } from '../../domain/shipment/tracking-event';
import { NotificationRepository, TrackingEventRepository, WebhookSubscriptionRepository } from '../ports/repositories';
import { AppLogger, Clock, DeliveryMetrics, DeliveryOutcome } from '../ports/system';
import { DeliveryResult, WebhookSender } from '../ports/webhook-sender';

export const WEBHOOK_EVENT_TYPE = 'guia.estado_actualizado';

/** Contrato del cuerpo enviado al webhook del cliente (versionado por `type`). */
export function toWebhookPayload(event: TrackingEvent): Record<string, unknown> {
  return {
    type: WEBHOOK_EVENT_TYPE,
    eventId: event.eventId.value,
    numeroGuia: event.trackingNumber.value,
    estado: event.status,
    fechaEvento: event.occurredAt.toISOString(),
    observacion: event.observation,
    recibidoEn: event.receivedAt.toISOString(),
  };
}

export interface DispatchSettings {
  batchSize: number;
  leaseMs: number;
}

/**
 * RF4: reclama notificaciones vencidas, las envía y registra el resultado según la
 * política de reintentos. Seguro con N instancias concurrentes (claim atómico).
 */
export class DispatchDueNotifications {
  constructor(
    private readonly notifications: NotificationRepository,
    private readonly events: TrackingEventRepository,
    private readonly subscriptions: WebhookSubscriptionRepository,
    private readonly sender: WebhookSender,
    private readonly retryPolicy: RetryPolicy,
    private readonly clock: Clock,
    private readonly logger: AppLogger,
    private readonly metrics: DeliveryMetrics,
    private readonly settings: DispatchSettings,
  ) {}

  /** Procesa un lote. Devuelve cuántas notificaciones reclamó (0 = no había trabajo). */
  async execute(): Promise<number> {
    const claimed = await this.notifications.claimDue(this.clock.now(), this.settings.batchSize, this.settings.leaseMs);
    const results = await Promise.allSettled(claimed.map((notification) => this.deliver(notification)));
    results.forEach((result, index) => {
      if (result.status === 'rejected') {
        // El lease vencerá y la notificación se reintentará: no se pierde.
        this.logger.error('Error inesperado despachando notificación', {
          notificationId: claimed[index]!.id,
          error: result.reason instanceof Error ? result.reason.name : 'unknown',
        });
      }
    });
    return claimed.length;
  }

  private async deliver(notification: Notification): Promise<void> {
    const attempt = notification.attempts;
    const startedAt = this.clock.now();
    const result = await this.attemptDelivery(notification);
    const finishedAt = this.clock.now();

    if (result.ok) {
      notification.recordSuccess(finishedAt, result.httpStatus);
    } else {
      notification.recordFailure(finishedAt, { errorCode: result.errorCode, httpStatus: result.httpStatus }, this.retryPolicy);
    }

    const persisted = await this.notifications.saveAttemptResult(notification, attempt);
    await this.notifications.recordAttempt({
      notificationId: notification.id,
      attemptNumber: attempt,
      attemptedAt: startedAt,
      durationMs: result.durationMs,
      httpStatus: result.httpStatus,
      errorCode: result.ok ? null : result.errorCode,
    });

    const outcome: DeliveryOutcome = !persisted
      ? 'DESCARTADA'
      : notification.status === 'ENVIADA'
        ? 'ENVIADA'
        : notification.status === 'FALLIDA'
          ? 'FALLIDA'
          : 'REINTENTO_PROGRAMADO';
    this.metrics.recordDelivery(outcome, result.durationMs);

    const context = {
      tenantId: notification.tenantId.value,
      notificationId: notification.id,
      eventId: notification.eventId.value,
      attempt,
      outcome,
      httpStatus: result.httpStatus,
      errorCode: result.ok ? null : result.errorCode,
      durationMs: result.durationMs,
    };
    if (outcome === 'FALLIDA') {
      this.logger.warn('Notificación marcada como FALLIDA tras agotar intentos', context);
    } else {
      this.logger.info('Intento de entrega de webhook', context);
    }
  }

  private async attemptDelivery(notification: Notification): Promise<DeliveryResult> {
    const [event, subscription] = await Promise.all([
      this.events.findById(notification.tenantId, notification.eventId),
      this.subscriptions.find(notification.tenantId),
    ]);
    if (!subscription) {
      return { ok: false, errorCode: 'WEBHOOK_NO_CONFIGURADO', httpStatus: null, durationMs: 0 };
    }
    if (!event) {
      throw new Error('Invariante violada: notificación sin evento');
    }
    return this.sender.send({
      url: subscription.url.value,
      secret: subscription.secret,
      messageId: event.eventId.value,
      attempt: notification.attempts,
      payload: toWebhookPayload(event),
    });
  }
}
