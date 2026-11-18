import { Provider } from '@nestjs/common';
import { Pool } from 'pg';
import { Logger } from 'pino';
import { NotificationRepository, ShipmentRepository, TrackingEventRepository, WebhookSubscriptionRepository } from '../../application/ports/repositories';
import { AppLogger, Clock } from '../../application/ports/system';
import { TransactionRunner } from '../../application/ports/transaction-runner';
import { WebhookDestinationPolicy, WebhookSender } from '../../application/ports/webhook-sender';
import { ConfigureWebhook, GetWebhook } from '../../application/use-cases/configure-webhook';
import { DispatchDueNotifications } from '../../application/use-cases/dispatch-due-notifications';
import { GetShipmentHistory } from '../../application/use-cases/get-shipment-history';
import { GetNotification, ListNotifications, RetryNotification } from '../../application/use-cases/notification-queries';
import { RegisterTrackingEvent } from '../../application/use-cases/register-tracking-event';
import { ExponentialBackoffPolicy, RetryPolicy } from '../../domain/notification/retry-policy';
import { AppConfig } from '../config/env';
import { AesGcmSecretCipher } from '../crypto/aes-gcm-secret-cipher';
import { CryptoIdGenerator, RandomSecretGenerator, SystemClock } from '../crypto/system-adapters';
import { PinoAppLogger } from '../observability/logger';
import { PrometheusMetrics } from '../observability/metrics';
import { createPool } from '../persistence/pg-pool';
import { PgTransactionRunner } from '../persistence/pg-transaction-runner';
import { PgNotificationRepository } from '../persistence/repositories/pg-notification-repository';
import { PgShipmentRepository } from '../persistence/repositories/pg-shipment-repository';
import { PgTrackingEventRepository } from '../persistence/repositories/pg-tracking-event-repository';
import { PgWebhookSubscriptionRepository } from '../persistence/repositories/pg-webhook-subscription-repository';
import { HttpWebhookSender } from '../webhook/http-webhook-sender';
import { NetworkWebhookDestinationPolicy } from '../webhook/ssrf-guard';
import { NotificationWorker } from '../worker/notification-worker';
import {
  APP_CONFIG,
  APP_LOGGER,
  CLOCK,
  DESTINATION_POLICY,
  EVENT_REPOSITORY,
  NOTIFICATION_REPOSITORY,
  PG_POOL,
  RETRY_POLICY,
  ROOT_LOGGER,
  SHIPMENT_REPOSITORY,
  SUBSCRIPTION_REPOSITORY,
  TRANSACTION_RUNNER,
  WEBHOOK_SENDER,
} from './tokens';

/**
 * Composition root: aquí, y solo aquí, se conectan los puertos con sus adaptadores.
 * Los casos de uso son clases TypeScript puras que se construyen con useFactory.
 */
export function buildProviders(config: AppConfig, rootLogger: Logger): Provider[] {
  return [
    { provide: APP_CONFIG, useValue: config },
    { provide: ROOT_LOGGER, useValue: rootLogger },
    { provide: APP_LOGGER, useFactory: (logger: Logger): AppLogger => new PinoAppLogger(logger.child({ component: 'dispatcher' })), inject: [ROOT_LOGGER] },
    { provide: PrometheusMetrics, useFactory: () => new PrometheusMetrics() },

    // --- Adaptadores de salida ---
    {
      provide: PG_POOL,
      useFactory: (): Pool =>
        createPool({
          connectionString: config.DATABASE_URL,
          max: config.DATABASE_POOL_MAX,
          ssl: config.DATABASE_SSL,
          statementTimeoutMs: config.DATABASE_STATEMENT_TIMEOUT_MS,
        }),
    },
    { provide: TRANSACTION_RUNNER, useFactory: (pool: Pool): TransactionRunner => new PgTransactionRunner(pool), inject: [PG_POOL] },
    { provide: SHIPMENT_REPOSITORY, useFactory: (pool: Pool): ShipmentRepository => new PgShipmentRepository(pool), inject: [PG_POOL] },
    { provide: EVENT_REPOSITORY, useFactory: (pool: Pool): TrackingEventRepository => new PgTrackingEventRepository(pool), inject: [PG_POOL] },
    { provide: NOTIFICATION_REPOSITORY, useFactory: (pool: Pool): NotificationRepository => new PgNotificationRepository(pool), inject: [PG_POOL] },
    {
      provide: SUBSCRIPTION_REPOSITORY,
      useFactory: (pool: Pool): WebhookSubscriptionRepository =>
        new PgWebhookSubscriptionRepository(pool, new AesGcmSecretCipher(config.WEBHOOK_SECRET_ENCRYPTION_KEY)),
      inject: [PG_POOL],
    },
    {
      provide: WEBHOOK_SENDER,
      useFactory: (): WebhookSender =>
        new HttpWebhookSender({ timeoutMs: config.WEBHOOK_TIMEOUT_MS, allowPrivateNetworks: config.WEBHOOK_ALLOW_PRIVATE_NETWORKS, userAgent: 'tracking-notifier/1.0' }),
    },
    {
      provide: DESTINATION_POLICY,
      useFactory: (): WebhookDestinationPolicy =>
        new NetworkWebhookDestinationPolicy({ allowPrivateNetworks: config.WEBHOOK_ALLOW_PRIVATE_NETWORKS, requireHttps: config.WEBHOOK_REQUIRE_HTTPS }),
    },
    { provide: CLOCK, useFactory: (): Clock => new SystemClock() },
    {
      provide: RETRY_POLICY,
      useFactory: (): RetryPolicy =>
        new ExponentialBackoffPolicy({
          maxAttempts: config.WEBHOOK_MAX_ATTEMPTS,
          baseDelayMs: config.WEBHOOK_RETRY_BASE_DELAY_MS,
          maxDelayMs: config.WEBHOOK_RETRY_MAX_DELAY_MS,
        }),
    },

    // --- Casos de uso (puertos de entrada) ---
    {
      provide: DispatchDueNotifications,
      useFactory: (
        notifications: NotificationRepository,
        events: TrackingEventRepository,
        subscriptions: WebhookSubscriptionRepository,
        sender: WebhookSender,
        policy: RetryPolicy,
        clock: Clock,
        logger: AppLogger,
        metrics: PrometheusMetrics,
      ) =>
        new DispatchDueNotifications(notifications, events, subscriptions, sender, policy, clock, logger, metrics, {
          batchSize: config.DISPATCHER_BATCH_SIZE,
          leaseMs: config.DISPATCHER_LEASE_MS,
        }),
      inject: [NOTIFICATION_REPOSITORY, EVENT_REPOSITORY, SUBSCRIPTION_REPOSITORY, WEBHOOK_SENDER, RETRY_POLICY, CLOCK, APP_LOGGER, PrometheusMetrics],
    },
    {
      provide: NotificationWorker,
      useFactory: (dispatch: DispatchDueNotifications, logger: AppLogger) =>
        new NotificationWorker(dispatch, logger, { pollIntervalMs: config.DISPATCHER_POLL_INTERVAL_MS }, config.DISPATCHER_BATCH_SIZE),
      inject: [DispatchDueNotifications, APP_LOGGER],
    },
    {
      provide: RegisterTrackingEvent,
      // El WorkSignal es el propio worker: si esta instancia no despacha (APP_ROLE=api), notify() no hace nada
      // y otra instancia (APP_ROLE=worker) lo recoge por polling.
      useFactory: (tx: TransactionRunner, clock: Clock, worker: NotificationWorker) =>
        new RegisterTrackingEvent(tx, clock, new CryptoIdGenerator(), worker, config.WEBHOOK_MAX_ATTEMPTS),
      inject: [TRANSACTION_RUNNER, CLOCK, NotificationWorker],
    },
    {
      provide: GetShipmentHistory,
      useFactory: (shipments: ShipmentRepository, events: TrackingEventRepository) => new GetShipmentHistory(shipments, events),
      inject: [SHIPMENT_REPOSITORY, EVENT_REPOSITORY],
    },
    {
      provide: ConfigureWebhook,
      useFactory: (subscriptions: WebhookSubscriptionRepository, policy: WebhookDestinationPolicy, clock: Clock) =>
        new ConfigureWebhook(subscriptions, policy, new RandomSecretGenerator(), clock),
      inject: [SUBSCRIPTION_REPOSITORY, DESTINATION_POLICY, CLOCK],
    },
    { provide: GetWebhook, useFactory: (s: WebhookSubscriptionRepository) => new GetWebhook(s), inject: [SUBSCRIPTION_REPOSITORY] },
    { provide: ListNotifications, useFactory: (n: NotificationRepository) => new ListNotifications(n), inject: [NOTIFICATION_REPOSITORY] },
    { provide: GetNotification, useFactory: (n: NotificationRepository) => new GetNotification(n), inject: [NOTIFICATION_REPOSITORY] },
    {
      provide: RetryNotification,
      useFactory: (n: NotificationRepository, clock: Clock, worker: NotificationWorker) => new RetryNotification(n, clock, worker),
      inject: [NOTIFICATION_REPOSITORY, CLOCK, NotificationWorker],
    },
  ];
}
