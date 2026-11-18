import { z } from 'zod';
import { NOTIFICATION_STATUSES } from '../../domain/notification/notification';
import { SHIPMENT_STATUSES } from '../../domain/shipment/shipment-status';
import { MAX_OBSERVATION_LENGTH } from '../../domain/shipment/tracking-event';

/** Contratos de entrada (validación estricta: campos desconocidos → 400). */

export const registerEventBodySchema = z.strictObject({
  eventId: z.uuid({ message: 'eventId debe ser un UUID' }),
  estado: z.enum(SHIPMENT_STATUSES, { message: `estado debe ser uno de: ${SHIPMENT_STATUSES.join(', ')}` }),
  // ISO 8601 con zona horaria explícita (Z u offset): evita ambigüedad de hora local.
  fechaEvento: z.iso.datetime({ offset: true, message: 'fechaEvento debe ser ISO 8601 con zona horaria (ej. 2026-11-18T10:00:00-05:00)' }),
  observacion: z.string().max(MAX_OBSERVATION_LENGTH).nullish(),
});
export type RegisterEventBody = z.infer<typeof registerEventBodySchema>;

export const configureWebhookBodySchema = z.strictObject({
  url: z.string().min(1).max(2048),
  rotarSecreto: z.boolean().optional().default(false),
});
export type ConfigureWebhookBody = z.infer<typeof configureWebhookBodySchema>;

export const trackingNumberParamSchema = z.string().regex(/^[A-Za-z0-9-]{1,40}$/, 'numeroGuia debe tener 1-40 caracteres [A-Za-z0-9-]');

export const notificationIdParamSchema = z.uuid({ message: 'id debe ser un UUID' });

export const listNotificationsQuerySchema = z.strictObject({
  estado: z.enum(NOTIFICATION_STATUSES).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional().default(50),
});
export type ListNotificationsQuery = z.infer<typeof listNotificationsQuerySchema>;
