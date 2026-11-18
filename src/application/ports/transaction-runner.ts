import { NotificationRepository, ShipmentRepository, TrackingEventRepository } from './repositories';

/** Repositorios ligados a una misma transacción (Unit of Work). */
export interface TransactionalContext {
  shipments: ShipmentRepository;
  events: TrackingEventRepository;
  notifications: NotificationRepository;
  /**
   * Bloqueo exclusivo por clave lógica hasta el fin de la transacción. Serializa
   * operaciones concurrentes sobre la misma guía o el mismo eventId (incluida la
   * creación de la guía, donde aún no existe fila que bloquear).
   */
  lock(key: string): Promise<void>;
}

export interface TransactionRunner {
  run<T>(work: (tx: TransactionalContext) => Promise<T>): Promise<T>;
}
