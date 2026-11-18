import { Controller, Get, HttpCode, Param, Post, Query } from '@nestjs/common';
import { GetNotification, ListNotifications, RetryNotification } from '../../../application/use-cases/notification-queries';
import { presentAttempt, presentNotification } from '../presenters';
import { ListNotificationsQuery, listNotificationsQuerySchema, notificationIdParamSchema } from '../schemas';
import { TenantHeader, ZodValidationPipe } from '../validation';

/** Consulta de notificaciones (las FALLIDA quedan consultables, RF4) y reintento manual. */
@Controller('v1/notificaciones')
export class NotificationsController {
  constructor(
    private readonly listNotifications: ListNotifications,
    private readonly getNotification: GetNotification,
    private readonly retryNotification: RetryNotification,
  ) {}

  @Get()
  async list(@TenantHeader() tenantId: string, @Query(new ZodValidationPipe(listNotificationsQuerySchema)) query: ListNotificationsQuery) {
    const items = await this.listNotifications.execute({ tenantId, status: query.estado, limit: query.limit });
    return { items: items.map(presentNotification) };
  }

  @Get(':id')
  async detail(@TenantHeader() tenantId: string, @Param('id', new ZodValidationPipe(notificationIdParamSchema, 'id')) id: string) {
    const { notification, attempts } = await this.getNotification.execute({ tenantId, id });
    return { ...presentNotification(notification), historialIntentos: attempts.map(presentAttempt) };
  }

  @Post(':id/reintentar')
  @HttpCode(202)
  async retry(@TenantHeader() tenantId: string, @Param('id', new ZodValidationPipe(notificationIdParamSchema, 'id')) id: string) {
    return presentNotification(await this.retryNotification.execute({ tenantId, id }));
  }
}
