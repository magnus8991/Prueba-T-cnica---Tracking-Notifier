import { DomainError } from '../shared/domain-error';

const TRACKING_NUMBER_PATTERN = /^[A-Za-z0-9-]{1,40}$/;

/** Número de guía de envío. */
export class TrackingNumber {
  private constructor(readonly value: string) {}

  static create(raw: string): TrackingNumber {
    if (typeof raw !== 'string' || !TRACKING_NUMBER_PATTERN.test(raw)) {
      throw new DomainError('NUMERO_GUIA_INVALIDO', 'El número de guía debe tener 1-40 caracteres [A-Za-z0-9-]');
    }
    return new TrackingNumber(raw);
  }

  equals(other: TrackingNumber): boolean {
    return this.value === other.value;
  }
}
