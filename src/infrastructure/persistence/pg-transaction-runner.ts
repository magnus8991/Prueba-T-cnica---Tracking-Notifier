import { Pool } from 'pg';
import { TransactionalContext, TransactionRunner } from '../../application/ports/transaction-runner';
import { PgNotificationRepository } from './repositories/pg-notification-repository';
import { PgShipmentRepository } from './repositories/pg-shipment-repository';
import { PgTrackingEventRepository } from './repositories/pg-tracking-event-repository';

/**
 * Unit of Work sobre una conexión dedicada. Los bloqueos lógicos usan
 * pg_advisory_xact_lock, que se liberan solos al COMMIT/ROLLBACK.
 */
export class PgTransactionRunner implements TransactionRunner {
  constructor(private readonly pool: Pool) {}

  async run<T>(work: (tx: TransactionalContext) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await work({
        shipments: new PgShipmentRepository(client),
        events: new PgTrackingEventRepository(client),
        notifications: new PgNotificationRepository(client),
        lock: async (key: string) => {
          await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [key]);
        },
      });
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }
}
