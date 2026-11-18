import { ArgumentsHost, BadRequestException, NotFoundException, PayloadTooLargeException } from '@nestjs/common';
import { ApplicationError } from '../../../src/application/errors';
import { DomainError } from '../../../src/domain/shared/domain-error';
import { ProblemDetailsFilter } from '../../../src/infrastructure/http/problem-details.filter';
import { RequestValidationError } from '../../../src/infrastructure/http/validation';

/** Formato único de error RFC 9457 para TODAS las fuentes de error, incluido el 500. */
describe('ProblemDetailsFilter (RFC 9457)', () => {
  const logged: unknown[] = [];
  const filter = new ProblemDetailsFilter({ error: (obj: unknown) => logged.push(obj) } as never);

  function run(exception: unknown) {
    const response = {
      statusCode: 0,
      contentType: '',
      body: undefined as Record<string, unknown> | undefined,
      status(code: number) {
        this.statusCode = code;
        return this;
      },
      type(t: string) {
        this.contentType = t;
        return this;
      },
      json(b: Record<string, unknown>) {
        this.body = b;
        return this;
      },
    };
    const request = { originalUrl: '/v1/guias/G-1/eventos?x=1', url: '/v1/guias/G-1/eventos', id: 'req-12345678' };
    const host = { switchToHttp: () => ({ getRequest: () => request, getResponse: () => response }) } as unknown as ArgumentsHost;
    filter.catch(exception, host);
    return response;
  }

  beforeEach(() => (logged.length = 0));

  it('500 genérico: no expone mensaje ni stack, incluye requestId y registra el error', () => {
    const res = run(new Error('connection refused at 10.0.0.5:5432 password=xyz'));
    expect(res.statusCode).toBe(500);
    expect(res.contentType).toBe('application/problem+json');
    expect(res.body).toMatchObject({ status: 500, code: 'ERROR_INTERNO', requestId: 'req-12345678', instance: '/v1/guias/G-1/eventos' });
    expect(JSON.stringify(res.body)).not.toMatch(/10\.0\.0\.5|password|stack/);
    expect(logged).toHaveLength(1);
  });

  it.each([
    [new DomainError('GUIA_EN_ESTADO_TERMINAL', 'x'), 409, 'GUIA_EN_ESTADO_TERMINAL'],
    [new DomainError('FECHA_EVENTO_FUTURA', 'x'), 400, 'FECHA_EVENTO_FUTURA'],
    [new ApplicationError('EVENT_ID_CONFLICTO', 'x'), 409, 'EVENT_ID_CONFLICTO'],
    [new ApplicationError('RECURSO_NO_ENCONTRADO', 'x'), 404, 'RECURSO_NO_ENCONTRADO'],
    [new RequestValidationError([{ path: 'a', message: 'b' }]), 400, 'VALIDACION_FALLIDA'],
    [new NotFoundException(), 404, 'RUTA_NO_ENCONTRADA'],
    [new BadRequestException(), 400, 'JSON_MALFORMADO'],
    [new PayloadTooLargeException(), 413, 'CUERPO_DEMASIADO_GRANDE'],
    [Object.assign(new Error('x'), { type: 'entity.parse.failed' }), 400, 'JSON_MALFORMADO'],
  ])('%s → %i %s', (exception, status, code) => {
    const res = run(exception);
    expect(res.statusCode).toBe(status);
    expect(res.body).toMatchObject({ status, code, type: expect.stringContaining(code.toLowerCase().replace(/_/g, '-')), title: expect.any(String), detail: expect.any(String) });
    expect(logged).toHaveLength(0); // los 4xx no se registran como error
  });
});
