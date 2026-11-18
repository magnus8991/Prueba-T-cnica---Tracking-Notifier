import { DomainError } from '../shared/domain-error';
import { EventId } from '../shipment/event-id';
import { TenantId } from '../tenant/tenant-id';
import { RetryPolicy } from './retry-policy';

export const NOTIFICATION_STATUSES = ['PENDIENTE', 'ENVIANDO', 'ENVIADA', 'FALLIDA'] as const;
export type NotificationStatus = (typeof NOTIFICATION_STATUSES)[number];

export interface NotificationProps {
  id: string;
  tenantId: TenantId;
  eventId: EventId;
  status: NotificationStatus;
  attempts: number;
  maxAttempts: number;
  nextAttemptAt: Date;
  lockedUntil: Date | null;
  lastError: string | null;
  lastHttpStatus: number | null;
  deliveredAt: Date | null;
  failedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface DeliveryFailure {
  errorCode: string;
  httpStatus: number | null;
}

/**
 * Notificación de un evento al webhook del tenant (fila del outbox).
 *
 * PENDIENTE ──claim──▶ ENVIANDO ──2xx──▶ ENVIADA
 *     ▲                   │
 *     └── fallo, quedan ──┤
 *         intentos        └── fallo, sin intentos ──▶ FALLIDA ──requeue──▶ PENDIENTE
 */
export class Notification {
  private constructor(private props: NotificationProps) {}

  static createFor(params: { id: string; tenantId: TenantId; eventId: EventId; maxAttempts: number; now: Date }): Notification {
    return new Notification({
      id: params.id,
      tenantId: params.tenantId,
      eventId: params.eventId,
      status: 'PENDIENTE',
      attempts: 0,
      maxAttempts: params.maxAttempts,
      nextAttemptAt: params.now,
      lockedUntil: null,
      lastError: null,
      lastHttpStatus: null,
      deliveredAt: null,
      failedAt: null,
      createdAt: params.now,
      updatedAt: params.now,
    });
  }

  static restore(props: NotificationProps): Notification {
    return new Notification({ ...props });
  }

  get id(): string {
    return this.props.id;
  }
  get tenantId(): TenantId {
    return this.props.tenantId;
  }
  get eventId(): EventId {
    return this.props.eventId;
  }
  get status(): NotificationStatus {
    return this.props.status;
  }
  get attempts(): number {
    return this.props.attempts;
  }

  /** ¿Puede un worker reclamarla ahora? Pendiente y vencida, o "enviando" con lease expirado (worker caído). */
  isDue(now: Date): boolean {
    if (this.props.status === 'PENDIENTE') return this.props.nextAttemptAt.getTime() <= now.getTime();
    if (this.props.status === 'ENVIANDO') return this.leaseExpired(now) && this.props.attempts < this.props.maxAttempts;
    return false;
  }

  /** Lease vencido en el último intento permitido: no se hace un intento extra, se marca FALLIDA. */
  isAbandonedAfterLastAttempt(now: Date): boolean {
    return this.props.status === 'ENVIANDO' && this.leaseExpired(now) && this.props.attempts >= this.props.maxAttempts;
  }

  abandon(now: Date): void {
    if (!this.isAbandonedAfterLastAttempt(now)) {
      throw new DomainError('TRANSICION_NOTIFICACION_INVALIDA', 'Solo se abandona un último intento con lease vencido');
    }
    this.props = { ...this.props, status: 'FALLIDA', lockedUntil: null, lastError: 'LEASE_EXPIRADO', failedAt: now, updatedAt: now };
  }

  private leaseExpired(now: Date): boolean {
    return (this.props.lockedUntil?.getTime() ?? 0) < now.getTime();
  }

  /** Un worker toma la notificación: el intento se cuenta al reclamar (acota reintentos ante caídas). */
  startAttempt(now: Date, leaseMs: number): void {
    if (!this.isDue(now)) {
      throw new DomainError('TRANSICION_NOTIFICACION_INVALIDA', `No se puede iniciar un intento en estado ${this.props.status}`);
    }
    this.props = {
      ...this.props,
      status: 'ENVIANDO',
      attempts: this.props.attempts + 1,
      lockedUntil: new Date(now.getTime() + leaseMs),
      updatedAt: now,
    };
  }

  recordSuccess(now: Date, httpStatus: number): void {
    this.assertSending();
    this.props = {
      ...this.props,
      status: 'ENVIADA',
      lockedUntil: null,
      lastError: null,
      lastHttpStatus: httpStatus,
      deliveredAt: now,
      updatedAt: now,
    };
  }

  recordFailure(now: Date, failure: DeliveryFailure, policy: RetryPolicy): void {
    this.assertSending();
    const exhausted = this.props.attempts >= this.props.maxAttempts;
    this.props = {
      ...this.props,
      status: exhausted ? 'FALLIDA' : 'PENDIENTE',
      lockedUntil: null,
      lastError: failure.errorCode,
      lastHttpStatus: failure.httpStatus,
      failedAt: exhausted ? now : null,
      nextAttemptAt: exhausted
        ? this.props.nextAttemptAt
        : new Date(now.getTime() + policy.delayAfterFailedAttempt(this.props.attempts)),
      updatedAt: now,
    };
  }

  /** Reintento manual de una notificación fallida: vuelve a la cola con el contador reiniciado. */
  requeue(now: Date): void {
    if (this.props.status !== 'FALLIDA') {
      throw new DomainError('NOTIFICACION_NO_REINTENTABLE', `Solo se pueden reintentar notificaciones FALLIDA (actual: ${this.props.status})`);
    }
    this.props = {
      ...this.props,
      status: 'PENDIENTE',
      attempts: 0,
      nextAttemptAt: now,
      failedAt: null,
      updatedAt: now,
    };
  }

  snapshot(): Readonly<NotificationProps> {
    return { ...this.props };
  }

  private assertSending(): void {
    if (this.props.status !== 'ENVIANDO') {
      throw new DomainError('TRANSICION_NOTIFICACION_INVALIDA', `Resultado de entrega en estado ${this.props.status}`);
    }
  }
}
