import { Notification, NotificationStatus } from '../../domain/notification/notification';
import { DomainError } from '../../domain/shared/domain-error';
import { TenantId } from '../../domain/tenant/tenant-id';
import { NotFoundError } from '../errors';
import { NotificationAttempt, NotificationRepository } from '../ports/repositories';
import { Clock, WorkSignal } from '../ports/system';

export const MAX_PAGE_SIZE = 100;

export class ListNotifications {
  constructor(private readonly notifications: NotificationRepository) {}

  execute(query: { tenantId: string; status?: NotificationStatus; limit?: number }): Promise<Notification[]> {
    const limit = Math.min(Math.max(query.limit ?? 50, 1), MAX_PAGE_SIZE);
    return this.notifications.list(TenantId.create(query.tenantId), { status: query.status, limit });
  }
}

export class GetNotification {
  constructor(private readonly notifications: NotificationRepository) {}

  async execute(query: { tenantId: string; id: string }): Promise<{ notification: Notification; attempts: NotificationAttempt[] }> {
    const tenantId = TenantId.create(query.tenantId);
    const notification = await this.notifications.findById(tenantId, query.id);
    if (!notification) {
      throw new NotFoundError('Notificación no encontrada');
    }
    const attempts = await this.notifications.listAttempts(tenantId, notification.id);
    return { notification, attempts };
  }
}

/** Reintento manual de una notificación FALLIDA (extra: operación de soporte). */
export class RetryNotification {
  constructor(
    private readonly notifications: NotificationRepository,
    private readonly clock: Clock,
    private readonly workSignal: WorkSignal,
  ) {}

  async execute(command: { tenantId: string; id: string }): Promise<Notification> {
    const notification = await this.notifications.findById(TenantId.create(command.tenantId), command.id);
    if (!notification) {
      throw new NotFoundError('Notificación no encontrada');
    }
    notification.requeue(this.clock.now()); // lanza si no está FALLIDA según la lectura
    // Reintentos concurrentes o lecturas obsoletas: solo gana quien la encuentre aún FALLIDA en la BD.
    if (!(await this.notifications.saveIfStatus(notification, 'FALLIDA'))) {
      throw new DomainError('NOTIFICACION_NO_REINTENTABLE', 'La notificación cambió de estado y ya no es reintentable');
    }
    this.workSignal.notify();
    return notification;
  }
}
