import { createParamDecorator, ExecutionContext, PipeTransform } from '@nestjs/common';
import { Request } from 'express';
import { ZodType } from 'zod';

export interface FieldError {
  path: string;
  message: string;
}

/** Error de validación de la petición (se traduce a 400 Problem Details con la lista de campos). */
export class RequestValidationError extends Error {
  constructor(
    readonly errors: FieldError[],
    readonly code: 'VALIDACION_FALLIDA' | 'TENANT_INVALIDO' = 'VALIDACION_FALLIDA',
  ) {
    super(code === 'TENANT_INVALIDO' ? 'Cabecera X-Tenant-Id ausente o inválida' : 'La petición no es válida');
  }
}

export class ZodValidationPipe<T> implements PipeTransform<unknown, T> {
  constructor(
    private readonly schema: ZodType<T>,
    private readonly rootPath = '',
  ) {}

  transform(value: unknown): T {
    const result = this.schema.safeParse(value);
    if (!result.success) {
      throw new RequestValidationError(
        result.error.issues.map((issue) => ({
          path: [this.rootPath, ...issue.path.map(String)].filter(Boolean).join('.') || '(body)',
          message: issue.message,
        })),
      );
    }
    return result.data;
  }
}

const TENANT_HEADER_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * Extrae el tenant de X-Tenant-Id. El API Gateway ya lo autenticó; aquí solo se
 * valida su forma. Es la ÚNICA fuente del tenant: nunca se acepta en body o query.
 */
export const TenantHeader = createParamDecorator((_data: unknown, ctx: ExecutionContext): string => {
  const value = ctx.switchToHttp().getRequest<Request>().header('x-tenant-id');
  if (!value || !TENANT_HEADER_PATTERN.test(value)) {
    throw new RequestValidationError([{ path: 'X-Tenant-Id', message: 'Cabecera obligatoria, 1-64 caracteres [A-Za-z0-9_-]' }], 'TENANT_INVALIDO');
  }
  return value;
});
