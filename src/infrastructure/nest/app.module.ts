import { DynamicModule, Inject, Module, OnApplicationBootstrap, OnApplicationShutdown, Type } from '@nestjs/common';
import { IncomingMessage, ServerResponse } from 'node:http';
import { LoggerModule } from 'nestjs-pino';
import { Pool } from 'pg';
import { Logger } from 'pino';
import { AppConfig } from '../config/env';
import { NotificationsController } from '../http/controllers/notifications.controller';
import { OpsController } from '../http/controllers/ops.controller';
import { ShipmentsController } from '../http/controllers/shipments.controller';
import { WebhookController } from '../http/controllers/webhook.controller';
import { gcpTraceFields, requestIdFrom } from '../observability/logger';
import { NotificationWorker } from '../worker/notification-worker';
import { buildProviders } from './providers';
import { APP_CONFIG, PG_POOL, ROOT_LOGGER } from './tokens';

/** Arranca/detiene el despachador según APP_ROLE y cierra recursos en el apagado (SIGTERM). */
class AppLifecycle implements OnApplicationBootstrap, OnApplicationShutdown {
  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(NotificationWorker) private readonly worker: NotificationWorker,
    @Inject(PG_POOL) private readonly pool: Pool,
    @Inject(ROOT_LOGGER) private readonly logger: Logger,
  ) {}

  onApplicationBootstrap(): void {
    if (this.config.APP_ROLE === 'all' || this.config.APP_ROLE === 'worker') {
      this.worker.start();
    }
  }

  async onApplicationShutdown(signal?: string): Promise<void> {
    this.logger.info({ signal }, 'Apagando servicio');
    await this.worker.stop();
    await this.pool.end();
  }
}

export interface AppModuleOptions {
  config: AppConfig;
  rootLogger: Logger;
}

@Module({})
export class AppModule {
  static forRoot({ config, rootLogger }: AppModuleOptions): DynamicModule {
    const apiControllers: Type[] = config.APP_ROLE === 'worker' ? [] : [ShipmentsController, WebhookController, NotificationsController];
    return {
      module: AppModule,
      imports: [
        LoggerModule.forRoot({
          pinoHttp: {
            logger: rootLogger,
            // Reutiliza el id asignado por el middleware temprano (create-app.ts) para que logs y respuestas coincidan.
            genReqId: (req: IncomingMessage, res: ServerResponse) => {
              const id = (req as IncomingMessage & { id?: string }).id ?? requestIdFrom(req);
              res.setHeader('X-Request-Id', id);
              return id;
            },
            customProps: (req: IncomingMessage) => gcpTraceFields(req, config.GOOGLE_CLOUD_PROJECT),
            autoLogging: { ignore: (req: IncomingMessage) => /^\/(health|metrics)/.test(req.url ?? '') },
            // Solo metadatos de la petición: nunca cuerpo ni cabeceras completas (pueden contener PII o secretos).
            serializers: {
              req: (req: { id: string; method: string; url: string; headers: Record<string, string> }) => ({
                id: req.id,
                method: req.method,
                path: req.url?.split('?')[0],
                tenantId: req.headers?.['x-tenant-id'],
              }),
              res: (res: { statusCode: number }) => ({ statusCode: res.statusCode }),
            },
          },
        }),
      ],
      controllers: [...apiControllers, OpsController],
      providers: [...buildProviders(config, rootLogger), AppLifecycle],
    };
  }
}
