import { DomainError } from '../shared/domain-error';

const TENANT_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

/** Identificador del cliente (tenant). Viene validado por el API Gateway, pero se re-valida su forma. */
export class TenantId {
  private constructor(readonly value: string) {}

  static create(raw: string): TenantId {
    if (typeof raw !== 'string' || !TENANT_ID_PATTERN.test(raw)) {
      throw new DomainError('TENANT_INVALIDO', 'El tenant debe tener 1-64 caracteres [A-Za-z0-9_-]');
    }
    return new TenantId(raw);
  }

  equals(other: TenantId): boolean {
    return this.value === other.value;
  }
}
