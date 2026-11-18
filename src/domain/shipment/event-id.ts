import { DomainError } from '../shared/domain-error';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Identificador del evento, generado por el emisor. Es la llave de idempotencia. */
export class EventId {
  private constructor(readonly value: string) {}

  static create(raw: string): EventId {
    if (typeof raw !== 'string' || !UUID_PATTERN.test(raw)) {
      throw new DomainError('EVENT_ID_INVALIDO', 'eventId debe ser un UUID');
    }
    return new EventId(raw.toLowerCase());
  }

  equals(other: EventId): boolean {
    return this.value === other.value;
  }
}
