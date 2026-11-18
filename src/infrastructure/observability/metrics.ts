import { Counter, Histogram, Registry, collectDefaultMetrics } from 'prom-client';
import { DeliveryMetrics, DeliveryOutcome } from '../../application/ports/system';

/** Métricas Prometheus (compatibles con Google Cloud Managed Service for Prometheus). */
export class PrometheusMetrics implements DeliveryMetrics {
  readonly registry = new Registry();

  private readonly deliveries = new Counter({
    name: 'webhook_deliveries_total',
    help: 'Intentos de entrega de webhooks por resultado',
    labelNames: ['outcome'] as const,
    registers: [this.registry],
  });

  private readonly deliveryDuration = new Histogram({
    name: 'webhook_delivery_duration_seconds',
    help: 'Duración de cada intento de entrega de webhook',
    buckets: [0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
    registers: [this.registry],
  });

  readonly httpRequests = new Histogram({
    name: 'http_request_duration_seconds',
    help: 'Duración de las peticiones HTTP',
    labelNames: ['method', 'route', 'status'] as const,
    buckets: [0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5],
    registers: [this.registry],
  });

  readonly trackingEvents = new Counter({
    name: 'tracking_events_total',
    help: 'Eventos de guía recibidos por resultado',
    labelNames: ['result'] as const,
    registers: [this.registry],
  });

  constructor(collectDefaults = true) {
    if (collectDefaults) collectDefaultMetrics({ register: this.registry });
  }

  recordDelivery(outcome: DeliveryOutcome, durationMs: number): void {
    this.deliveries.inc({ outcome });
    this.deliveryDuration.observe(durationMs / 1000);
  }
}
