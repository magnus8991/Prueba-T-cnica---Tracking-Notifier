import {
  NotificationAttempt,
  NotificationQuery,
  NotificationRepository,
  ShipmentRepository,
  TrackingEventRepository,
  WebhookSubscriptionRepository,
} from '../../src/application/ports/repositories';
import { AppLogger, Clock, DeliveryMetrics, DeliveryOutcome, IdGenerator, SecretGenerator, WorkSignal } from '../../src/application/ports/system';
import { TransactionalContext, TransactionRunner } from '../../src/application/ports/transaction-runner';
import { DeliveryResult, WebhookDelivery, WebhookDestinationPolicy, WebhookSender } from '../../src/application/ports/webhook-sender';
import { Notification, NotificationProps } from '../../src/domain/notification/notification';
import { EventId } from '../../src/domain/shipment/event-id';
import { Shipment, ShipmentSnapshot } from '../../src/domain/shipment/shipment';
import { TrackingEvent } from '../../src/domain/shipment/tracking-event';
import { TrackingNumber } from '../../src/domain/shipment/tracking-number';
import { TenantId } from '../../src/domain/tenant/tenant-id';
import { WebhookSubscription } from '../../src/domain/webhook/webhook-subscription';

/**
 * Fakes en memoria de los puertos de salida. Guardan snapshots (no referencias)
 * para comportarse como una BD real, y la transacción es copy-on-write: si el
 * trabajo lanza, no se aplica nada (rollback).
 */
interface State {
  shipments: Map<string, ShipmentSnapshot>;
  events: Map<string, TrackingEvent>;
  eventOrder: string[];
  notifications: Map<string, NotificationProps>;
  attempts: NotificationAttempt[];
}

const key = (...parts: string[]) => parts.join('|');

function cloneState(state: State): State {
  return {
    shipments: new Map(state.shipments),
    events: new Map(state.events),
    eventOrder: [...state.eventOrder],
    notifications: new Map(state.notifications),
    attempts: [...state.attempts],
  };
}

class InMemoryShipments implements ShipmentRepository {
  constructor(private readonly state: () => State) {}
  async find(tenantId: TenantId, trackingNumber: TrackingNumber) {
    const snapshot = this.state().shipments.get(key(tenantId.value, trackingNumber.value));
    return snapshot ? Shipment.restore(snapshot) : null;
  }
  async save(shipment: Shipment) {
    const snapshot = shipment.snapshot();
    this.state().shipments.set(key(snapshot.tenantId.value, snapshot.trackingNumber.value), snapshot);
  }
}

class InMemoryEvents implements TrackingEventRepository {
  constructor(private readonly state: () => State) {}
  async findById(tenantId: TenantId, eventId: EventId) {
    return this.state().events.get(key(tenantId.value, eventId.value)) ?? null;
  }
  async add(event: TrackingEvent) {
    const k = key(event.tenantId.value, event.eventId.value);
    if (this.state().events.has(k)) throw new Error('unique_violation');
    this.state().events.set(k, event);
    this.state().eventOrder.push(k);
  }
  async listByShipment(tenantId: TenantId, trackingNumber: TrackingNumber) {
    const s = this.state();
    return s.eventOrder
      .map((k, seq) => ({ event: s.events.get(k)!, seq }))
      .filter(({ event }) => event.tenantId.equals(tenantId) && event.trackingNumber.equals(trackingNumber))
      .sort((a, b) => a.event.occurredAt.getTime() - b.event.occurredAt.getTime() || a.seq - b.seq)
      .map(({ event }) => event);
  }
}

class InMemoryNotifications implements NotificationRepository {
  constructor(private readonly state: () => State) {}
  async add(n: Notification) {
    const s = this.state();
    const duplicate = [...s.notifications.values()].some((p) => p.tenantId.equals(n.tenantId) && p.eventId.equals(n.eventId));
    if (duplicate) throw new Error('unique_violation');
    s.notifications.set(n.id, n.snapshot());
  }
  async findById(tenantId: TenantId, id: string) {
    const p = this.state().notifications.get(id);
    return p && p.tenantId.equals(tenantId) ? Notification.restore(p) : null;
  }
  async list(tenantId: TenantId, query: NotificationQuery) {
    return [...this.state().notifications.values()]
      .filter((p) => p.tenantId.equals(tenantId) && (!query.status || p.status === query.status))
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
      .slice(0, query.limit)
      .map((p) => Notification.restore(p));
  }
  async saveAttemptResult(n: Notification, expectedAttempts: number) {
    const current = this.state().notifications.get(n.id);
    if (!current || current.status !== 'ENVIANDO' || current.attempts !== expectedAttempts) return false;
    this.state().notifications.set(n.id, n.snapshot());
    return true;
  }
  async save(n: Notification) {
    this.state().notifications.set(n.id, n.snapshot());
  }
  async claimDue(now: Date, limit: number, leaseMs: number) {
    const due = [...this.state().notifications.values()]
      .map((p) => Notification.restore(p))
      .filter((n) => n.isDue(now))
      .slice(0, limit);
    for (const n of due) {
      n.startAttempt(now, leaseMs);
      this.state().notifications.set(n.id, n.snapshot());
    }
    return due;
  }
  async recordAttempt(attempt: NotificationAttempt) {
    this.state().attempts.push(attempt);
  }
  async listAttempts(tenantId: TenantId, notificationId: string) {
    const p = this.state().notifications.get(notificationId);
    if (!p || !p.tenantId.equals(tenantId)) return [];
    return this.state().attempts.filter((a) => a.notificationId === notificationId);
  }
}

export class InMemoryDatabase implements TransactionRunner {
  private state: State = { shipments: new Map(), events: new Map(), eventOrder: [], notifications: new Map(), attempts: [] };
  readonly shipments = new InMemoryShipments(() => this.state);
  readonly events = new InMemoryEvents(() => this.state);
  readonly notifications = new InMemoryNotifications(() => this.state);
  readonly locks: string[] = [];

  async run<T>(work: (tx: TransactionalContext) => Promise<T>): Promise<T> {
    const draft = cloneState(this.state);
    const result = await work({
      shipments: new InMemoryShipments(() => draft),
      events: new InMemoryEvents(() => draft),
      notifications: new InMemoryNotifications(() => draft),
      lock: async (k) => {
        this.locks.push(k);
      },
    });
    this.state = draft; // commit
    return result;
  }

  get allNotifications(): NotificationProps[] {
    return [...this.state.notifications.values()];
  }
  get allEvents(): TrackingEvent[] {
    return [...this.state.events.values()];
  }
  get allAttempts(): NotificationAttempt[] {
    return [...this.state.attempts];
  }
}

export class InMemorySubscriptions implements WebhookSubscriptionRepository {
  private readonly items = new Map<string, WebhookSubscription>();
  async find(tenantId: TenantId) {
    return this.items.get(tenantId.value) ?? null;
  }
  async save(subscription: WebhookSubscription) {
    this.items.set(subscription.tenantId.value, subscription);
  }
}

export class FixedClock implements Clock {
  constructor(private current: Date = new Date('2026-11-01T10:00:00Z')) {}
  now() {
    return new Date(this.current);
  }
  advance(ms: number) {
    this.current = new Date(this.current.getTime() + ms);
  }
  set(date: Date) {
    this.current = new Date(date);
  }
}

export class SequentialIds implements IdGenerator {
  private n = 0;
  uuid() {
    this.n += 1;
    return `aaaaaaaa-0000-4000-8000-${this.n.toString().padStart(12, '0')}`;
  }
}

export class FakeSecrets implements SecretGenerator {
  private n = 0;
  generate() {
    this.n += 1;
    return `whsec_fake${this.n}`;
  }
}

export class SpyWorkSignal implements WorkSignal {
  calls = 0;
  notify() {
    this.calls += 1;
  }
}

export class ScriptedSender implements WebhookSender {
  readonly deliveries: WebhookDelivery[] = [];
  constructor(private readonly script: (delivery: WebhookDelivery) => DeliveryResult = () => ({ ok: true, httpStatus: 200, durationMs: 5 })) {}
  async send(delivery: WebhookDelivery) {
    this.deliveries.push(delivery);
    return this.script(delivery);
  }
}

export class AllowAllDestinations implements WebhookDestinationPolicy {
  async assertAllowed() {}
}

export class SilentLogger implements AppLogger {
  readonly entries: { level: string; message: string; context?: object }[] = [];
  info(message: string, context?: object) {
    this.entries.push({ level: 'info', message, context });
  }
  warn(message: string, context?: object) {
    this.entries.push({ level: 'warn', message, context });
  }
  error(message: string, context?: object) {
    this.entries.push({ level: 'error', message, context });
  }
}

export class SpyMetrics implements DeliveryMetrics {
  readonly outcomes: DeliveryOutcome[] = [];
  recordDelivery(outcome: DeliveryOutcome) {
    this.outcomes.push(outcome);
  }
}
