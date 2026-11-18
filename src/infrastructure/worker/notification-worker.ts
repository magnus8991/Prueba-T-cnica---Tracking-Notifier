import { AppLogger, WorkSignal } from '../../application/ports/system';
import { DispatchDueNotifications } from '../../application/use-cases/dispatch-due-notifications';

export interface WorkerSettings {
  pollIntervalMs: number;
}

/**
 * Bucle del despachador (adaptador "driving" del caso de uso DispatchDueNotifications).
 *  - Despierta por polling o por señal (WorkSignal) cuando la API acepta un evento.
 *  - Si un lote vino lleno, vuelve a ejecutar de inmediato (drena la cola).
 *  - stop() deja de reclamar trabajo y espera el lote en curso (apagado ordenado / SIGTERM).
 *  - Sin estado de negocio en memoria: N réplicas pueden correrlo a la vez.
 */
export class NotificationWorker implements WorkSignal {
  private running = false;
  private timer: NodeJS.Timeout | null = null;
  private wakeRequested = false;
  private currentRun: Promise<void> | null = null;

  constructor(
    private readonly dispatch: DispatchDueNotifications,
    private readonly logger: AppLogger,
    private readonly settings: WorkerSettings,
    private readonly batchSize: number,
  ) {}

  start(): void {
    if (this.running) return;
    this.running = true;
    this.logger.info('Despachador de notificaciones iniciado', { pollIntervalMs: this.settings.pollIntervalMs });
    this.schedule(0);
  }

  /** WorkSignal: hay trabajo nuevo, ejecutar cuanto antes. */
  notify(): void {
    if (!this.running) return;
    if (this.currentRun) {
      this.wakeRequested = true;
      return;
    }
    this.schedule(0);
  }

  async stop(): Promise<void> {
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    await this.currentRun;
    this.logger.info('Despachador de notificaciones detenido');
  }

  /** Ejecuta un ciclo completo (útil en pruebas y para un trigger externo, p.ej. Cloud Scheduler). */
  async runOnce(): Promise<number> {
    return this.dispatch.execute();
  }

  private schedule(delayMs: number): void {
    if (!this.running) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.tick(), delayMs);
  }

  private async tick(): Promise<void> {
    this.timer = null;
    if (!this.running || this.currentRun) return;
    let claimed = 0;
    this.currentRun = (async () => {
      try {
        claimed = await this.dispatch.execute();
      } catch (error) {
        this.logger.error('Fallo en el ciclo del despachador (se reintentará)', { error: error instanceof Error ? error.message : 'unknown' });
      }
    })();
    await this.currentRun;
    this.currentRun = null;

    const moreWork = claimed >= this.batchSize || this.wakeRequested;
    this.wakeRequested = false;
    this.schedule(moreWork ? 0 : this.settings.pollIntervalMs);
  }
}
