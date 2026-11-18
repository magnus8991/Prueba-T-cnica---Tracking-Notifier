import { ArgumentsHost, Catch, ExceptionFilter, HttpException, HttpStatus } from '@nestjs/common';
import { Request, Response } from 'express';
import { Logger } from 'pino';
import { ApplicationError, ApplicationErrorCode } from '../../application/errors';
import { DomainError, DomainErrorCode } from '../../domain/shared/domain-error';
import { FieldError, RequestValidationError } from './validation';

const PROBLEM_TYPE_BASE = 'https://tracking-notifier.domina.dev/problemas/';

/** RFC 9457 Problem Details: formato ÚNICO de error para toda la API. */
export interface ProblemDetails {
  type: string;
  title: string;
  status: number;
  detail: string;
  instance: string;
  code: string;
  requestId?: string;
  errors?: FieldError[];
}

const STATUS_BY_CODE: Record<DomainErrorCode | ApplicationErrorCode, number> = {
  TENANT_INVALIDO: 400,
  NUMERO_GUIA_INVALIDO: 400,
  EVENT_ID_INVALIDO: 400,
  ESTADO_INVALIDO: 400,
  FECHA_EVENTO_INVALIDA: 400,
  OBSERVACION_INVALIDA: 400,
  URL_WEBHOOK_INVALIDA: 400,
  URL_WEBHOOK_NO_PERMITIDA: 400,
  GUIA_EN_ESTADO_TERMINAL: 409,
  EVENT_ID_CONFLICTO: 409,
  NOTIFICACION_NO_REINTENTABLE: 409,
  EVENTO_NO_PERTENECE_A_GUIA: 422,
  TRANSICION_NOTIFICACION_INVALIDA: 409,
  RECURSO_NO_ENCONTRADO: 404,
};

const TITLES: Record<number, string> = {
  400: 'Petición inválida',
  404: 'Recurso no encontrado',
  405: 'Método no permitido',
  409: 'Conflicto con el estado del recurso',
  413: 'Cuerpo demasiado grande',
  415: 'Tipo de contenido no soportado',
  422: 'Entidad no procesable',
  500: 'Error interno',
  503: 'Servicio no disponible',
};

function slug(code: string): string {
  return code.toLowerCase().replace(/_/g, '-');
}

/** Errores del body-parser de Express (JSON malformado, cuerpo muy grande, etc.). */
function bodyParserError(error: unknown): { status: number; code: string; detail: string } | null {
  if (typeof error !== 'object' || error === null || !('type' in error)) return null;
  switch ((error as { type: string }).type) {
    case 'entity.parse.failed':
      return { status: 400, code: 'JSON_MALFORMADO', detail: 'El cuerpo no es un JSON válido' };
    case 'entity.too.large':
      return { status: 413, code: 'CUERPO_DEMASIADO_GRANDE', detail: 'El cuerpo excede el tamaño permitido' };
    case 'encoding.unsupported':
    case 'charset.unsupported':
      return { status: 415, code: 'CODIFICACION_NO_SOPORTADA', detail: 'Codificación no soportada' };
    default:
      return null;
  }
}

@Catch()
export class ProblemDetailsFilter implements ExceptionFilter {
  constructor(private readonly logger: Logger) {}

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const request = ctx.getRequest<Request & { id?: string }>();
    const response = ctx.getResponse<Response>();
    const problem = this.toProblem(exception, request);

    if (problem.status >= 500) {
      // Se registra el tipo de error y el requestId, nunca el cuerpo de la petición.
      this.logger.error(
        { requestId: problem.requestId, errorName: exception instanceof Error ? exception.name : typeof exception, stack: exception instanceof Error ? exception.stack : undefined },
        'Error no controlado',
      );
    }
    response.status(problem.status).type('application/problem+json').json(problem);
  }

  private toProblem(exception: unknown, request: Request & { id?: string }): ProblemDetails {
    const base = { instance: request.originalUrl?.split('?')[0] ?? request.url, requestId: request.id ? String(request.id) : undefined };

    if (exception instanceof RequestValidationError) {
      return { ...base, ...this.describe(400, exception.code, exception.message), errors: exception.errors };
    }
    if (exception instanceof DomainError || exception instanceof ApplicationError) {
      const status = STATUS_BY_CODE[exception.code] ?? 400;
      return { ...base, ...this.describe(status, exception.code, exception.message) };
    }
    // Nest puede entregar el error del body-parser tal cual o envuelto en una HttpException (con `cause`).
    const parser = bodyParserError(exception) ?? (exception instanceof HttpException ? bodyParserError(exception.cause) : null);
    if (parser) {
      return { ...base, ...this.describe(parser.status, parser.code, parser.detail) };
    }
    if (exception instanceof HttpException) {
      return { ...base, ...this.fromFrameworkHttpException(exception) };
    }
    return { ...base, ...this.describe(500, 'ERROR_INTERNO', 'Ocurrió un error inesperado. Use el requestId para soporte.') };
  }

  /**
   * HttpException lanzadas por el framework (las del dominio/aplicación ya se trataron antes).
   * Las validaciones propias usan RequestValidationError, así que un 400 del framework proviene
   * del parseo del cuerpo JSON.
   */
  private fromFrameworkHttpException(exception: HttpException) {
    const status = exception.getStatus();
    switch (status) {
      case HttpStatus.NOT_FOUND:
        return this.describe(status, 'RUTA_NO_ENCONTRADA', 'La ruta solicitada no existe');
      case HttpStatus.BAD_REQUEST:
        return this.describe(status, 'JSON_MALFORMADO', 'El cuerpo no es un JSON válido');
      case HttpStatus.PAYLOAD_TOO_LARGE:
        return this.describe(status, 'CUERPO_DEMASIADO_GRANDE', 'El cuerpo excede el tamaño permitido');
      case HttpStatus.SERVICE_UNAVAILABLE:
        return this.describe(status, 'SERVICIO_NO_DISPONIBLE', 'Una dependencia no está disponible');
      default:
        return this.describe(status, `HTTP_${status}`, TITLES[status] ?? 'Error HTTP');
    }
  }

  private describe(status: number, code: string, detail: string) {
    return { type: `${PROBLEM_TYPE_BASE}${slug(code)}`, title: TITLES[status] ?? 'Error', status, detail, code };
  }
}
