/**
 * Códigos de error de dominio. Son estables: la capa HTTP los traduce a
 * Problem Details (RFC 9457) y los clientes pueden depender de ellos.
 */
export type DomainErrorCode =
  | 'TENANT_INVALIDO'
  | 'NUMERO_GUIA_INVALIDO'
  | 'EVENT_ID_INVALIDO'
  | 'ESTADO_INVALIDO'
  | 'FECHA_EVENTO_INVALIDA'
  | 'OBSERVACION_INVALIDA'
  | 'URL_WEBHOOK_INVALIDA'
  | 'GUIA_EN_ESTADO_TERMINAL'
  | 'EVENTO_NO_PERTENECE_A_GUIA'
  | 'NOTIFICACION_NO_REINTENTABLE'
  | 'TRANSICION_NOTIFICACION_INVALIDA';

export class DomainError extends Error {
  constructor(
    readonly code: DomainErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'DomainError';
  }
}
