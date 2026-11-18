export type DeliveryErrorCode =
  | 'TIMEOUT'
  | 'HTTP_ERROR'
  | 'NETWORK_ERROR'
  | 'DESTINO_NO_PERMITIDO'
  | 'WEBHOOK_NO_CONFIGURADO';

export interface WebhookDelivery {
  url: string;
  secret: string;
  /** Identificador estable entre reintentos (= eventId) para que el receptor deduplique. */
  messageId: string;
  attempt: number;
  payload: Record<string, unknown>;
}

export type DeliveryResult =
  | { ok: true; httpStatus: number; durationMs: number }
  | { ok: false; errorCode: DeliveryErrorCode; httpStatus: number | null; durationMs: number };

/** Puerto de salida hacia el sistema del cliente. Nunca lanza: siempre devuelve un resultado. */
export interface WebhookSender {
  send(delivery: WebhookDelivery): Promise<DeliveryResult>;
}

/** Política de destinos permitidos (anti-SSRF, https obligatorio, etc.). */
export interface WebhookDestinationPolicy {
  /** Valida la URL al configurarla. Lanza ApplicationError('URL_WEBHOOK_NO_PERMITIDA') si no es aceptable. */
  assertAllowed(url: URL): Promise<void>;
}
