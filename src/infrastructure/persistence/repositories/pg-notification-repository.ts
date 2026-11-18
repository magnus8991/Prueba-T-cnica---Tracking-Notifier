import { NotificationAttempt, NotificationQuery, NotificationRepository } from '../../../application/ports/repositories';
import { Notification, NotificationStatus } from '../../../domain/notification/notification';
import { EventId } from '../../../domain/shipment/event-id';
import { TenantId } from '../../../domain/tenant/tenant-id';
import { Queryable } from '../pg-pool';

interface NotificationRow {
  id: string;
  tenant_id: string;
  event_id: string;
  status: NotificationStatus;
  attempts: number;
  max_attempts: number;
  next_attempt_at: Date;
  locked_until: Date | null;
  last_error: string | null;
  last_http_status: number | null;
  delivered_at: Date | null;
  failed_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

interface AttemptRow {
  notification_id: string;
  attempt_number: number;
  attempted_at: Date;
  duration_ms: number;
  http_status: number | null;
  error_code: string | null;
}

const COLUMNS = `id, tenant_id, event_id, status, attempts, max_attempts, next_attempt_at, locked_until,
  last_error, last_http_status, delivered_at, failed_at, created_at, updated_at`;

function toDomain(row: NotificationRow): Notification {
  return Notification.restore({
    id: row.id,
    tenantId: TenantId.create(row.tenant_id),
    eventId: EventId.create(row.event_id),
    status: row.status,
    attempts: row.attempts,
    maxAttempts: row.max_attempts,
    nextAttemptAt: row.next_attempt_at,
    lockedUntil: row.locked_until,
    lastError: row.last_error,
    lastHttpStatus: row.last_http_status,
    deliveredAt: row.delivered_at,
    failedAt: row.failed_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });
}

export class PgNotificationRepository implements NotificationRepository {
  constructor(private readonly db: Queryable) {}

  async add(notification: Notification): Promise<void> {
    const n = notification.snapshot();
    await this.db.query(
      `INSERT INTO notifications (${COLUMNS})
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
      [
        n.id,
        n.tenantId.value,
        n.eventId.value,
        n.status,
        n.attempts,
        n.maxAttempts,
        n.nextAttemptAt,
        n.lockedUntil,
        n.lastError,
        n.lastHttpStatus,
        n.deliveredAt,
        n.failedAt,
        n.createdAt,
        n.updatedAt,
      ],
    );
  }

  async findById(tenantId: TenantId, id: string): Promise<Notification | null> {
    const { rows } = await this.db.query<NotificationRow>(`SELECT ${COLUMNS} FROM notifications WHERE tenant_id = $1 AND id = $2`, [tenantId.value, id]);
    return rows[0] ? toDomain(rows[0]) : null;
  }

  async list(tenantId: TenantId, query: NotificationQuery): Promise<Notification[]> {
    const { rows } = await this.db.query<NotificationRow>(
      `SELECT ${COLUMNS} FROM notifications
        WHERE tenant_id = $1 AND ($2::text IS NULL OR status = $2)
        ORDER BY created_at DESC, id
        LIMIT $3`,
      [tenantId.value, query.status ?? null, query.limit],
    );
    return rows.map(toDomain);
  }

  async saveAttemptResult(notification: Notification, expectedAttempts: number): Promise<boolean> {
    const n = notification.snapshot();
    const { rowCount } = await this.db.query(
      `UPDATE notifications
          SET status = $3, attempts = $4, next_attempt_at = $5, locked_until = $6, last_error = $7,
              last_http_status = $8, delivered_at = $9, failed_at = $10, updated_at = $11
        WHERE id = $1 AND status = 'ENVIANDO' AND attempts = $2`,
      [n.id, expectedAttempts, n.status, n.attempts, n.nextAttemptAt, n.lockedUntil, n.lastError, n.lastHttpStatus, n.deliveredAt, n.failedAt, n.updatedAt],
    );
    return rowCount === 1;
  }

  async saveIfStatus(notification: Notification, expectedStatus: NotificationStatus): Promise<boolean> {
    const n = notification.snapshot();
    const { rowCount } = await this.db.query(
      `UPDATE notifications
          SET status = $4, attempts = $5, next_attempt_at = $6, locked_until = $7, last_error = $8,
              last_http_status = $9, delivered_at = $10, failed_at = $11, updated_at = $12
        WHERE id = $1 AND tenant_id = $2 AND status = $3`,
      [n.id, n.tenantId.value, expectedStatus, n.status, n.attempts, n.nextAttemptAt, n.lockedUntil, n.lastError, n.lastHttpStatus, n.deliveredAt, n.failedAt, n.updatedAt],
    );
    return rowCount === 1;
  }

  /**
   * Claim atómico tipo cola: FOR UPDATE SKIP LOCKED permite N workers concurrentes sin
   * bloquearse ni tomar la misma fila. Antes, cierra como FALLIDA cualquier último intento
   * cuyo worker murió (lease vencido) para no exceder el máximo de intentos.
   */
  async claimDue(now: Date, limit: number, leaseMs: number): Promise<Notification[]> {
    await this.db.query(
      `WITH abandoned AS (
         UPDATE notifications
            SET status = 'FALLIDA', locked_until = NULL, last_error = 'LEASE_EXPIRADO', last_http_status = NULL,
                failed_at = $1, updated_at = $1
          WHERE status = 'ENVIANDO' AND locked_until < $1 AND attempts >= max_attempts
         RETURNING id, attempts
       )
       INSERT INTO notification_attempts (notification_id, attempt_number, attempted_at, duration_ms, http_status, error_code)
       SELECT id, attempts, $1, 0, NULL, 'LEASE_EXPIRADO' FROM abandoned`,
      [now],
    );
    const { rows } = await this.db.query<NotificationRow>(
      `WITH due AS (
         SELECT id FROM notifications
          WHERE (status = 'PENDIENTE' AND next_attempt_at <= $1)
             OR (status = 'ENVIANDO' AND locked_until < $1 AND attempts < max_attempts)
          ORDER BY next_attempt_at
          LIMIT $2
          FOR UPDATE SKIP LOCKED
       )
       UPDATE notifications n
          SET status = 'ENVIANDO',
              attempts = n.attempts + 1,
              locked_until = $1::timestamptz + make_interval(secs => $3::double precision / 1000),
              updated_at = $1
         FROM due
        WHERE n.id = due.id
      RETURNING ${COLUMNS.split(',')
        .map((c) => `n.${c.trim()}`)
        .join(', ')}`,
      [now, limit, leaseMs],
    );
    return rows.map(toDomain);
  }

  async recordAttempt(attempt: NotificationAttempt): Promise<void> {
    await this.db.query(
      `INSERT INTO notification_attempts (notification_id, attempt_number, attempted_at, duration_ms, http_status, error_code)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [attempt.notificationId, attempt.attemptNumber, attempt.attemptedAt, Math.round(attempt.durationMs), attempt.httpStatus, attempt.errorCode],
    );
  }

  async listAttempts(tenantId: TenantId, notificationId: string): Promise<NotificationAttempt[]> {
    const { rows } = await this.db.query<AttemptRow>(
      `SELECT a.notification_id, a.attempt_number, a.attempted_at, a.duration_ms, a.http_status, a.error_code
         FROM notification_attempts a
         JOIN notifications n ON n.id = a.notification_id
        WHERE n.tenant_id = $1 AND a.notification_id = $2
        ORDER BY a.id`,
      [tenantId.value, notificationId],
    );
    return rows.map((r) => ({
      notificationId: r.notification_id,
      attemptNumber: r.attempt_number,
      attemptedAt: r.attempted_at,
      durationMs: r.duration_ms,
      httpStatus: r.http_status,
      errorCode: r.error_code,
    }));
  }
}
