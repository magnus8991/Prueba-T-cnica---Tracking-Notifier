import { Controller, Get, Header, HttpException, Inject } from '@nestjs/common';
import { Pool } from 'pg';
import { PrometheusMetrics } from '../../observability/metrics';
import { PG_POOL } from '../../nest/tokens';

/** Endpoints operativos para el orquestador (Cloud Run / Kubernetes) y monitoreo. */
@Controller()
export class OpsController {
  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    private readonly metrics: PrometheusMetrics,
  ) {}

  /** Liveness: el proceso responde (no depende de la BD para no provocar reinicios en cascada). */
  @Get('health/live')
  live() {
    return { status: 'ok' };
  }

  /** Readiness: puede atender tráfico (BD accesible). */
  @Get('health/ready')
  async ready() {
    try {
      await this.pool.query('SELECT 1');
      return { status: 'ok', checks: { database: 'up' } };
    } catch {
      throw new HttpException({ status: 'error', checks: { database: 'down' } }, 503);
    }
  }

  @Get('metrics')
  @Header('Cache-Control', 'no-store')
  @Header('Content-Type', 'text/plain; version=0.0.4; charset=utf-8')
  async prometheus(): Promise<string> {
    return this.metrics.registry.metrics();
  }
}
