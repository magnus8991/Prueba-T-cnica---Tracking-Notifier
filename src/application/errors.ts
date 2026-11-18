export type ApplicationErrorCode = 'RECURSO_NO_ENCONTRADO' | 'EVENT_ID_CONFLICTO' | 'URL_WEBHOOK_NO_PERMITIDA';

/** Errores de la capa de aplicación (no son reglas de dominio puras). */
export class ApplicationError extends Error {
  constructor(
    readonly code: ApplicationErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'ApplicationError';
  }
}

export class NotFoundError extends ApplicationError {
  constructor(resource: string) {
    super('RECURSO_NO_ENCONTRADO', `${resource} no encontrado`);
  }
}
