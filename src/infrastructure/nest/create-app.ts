import { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import { SwaggerModule } from '@nestjs/swagger';
import { NextFunction, Request, Response } from 'express';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Logger as NestPinoLogger } from 'nestjs-pino';
import { Logger } from 'pino';
import { parse as parseYaml } from 'yaml';
import { AppConfig } from '../config/env';
import { ProblemDetailsFilter } from '../http/problem-details.filter';
import { PrometheusMetrics } from '../observability/metrics';
import { AppModule } from './app.module';

const BODY_LIMIT = '16kb';

/** Construye la aplicación HTTP con todas sus políticas transversales (usada por main.ts y por las pruebas E2E). */
export async function createApp(config: AppConfig, rootLogger: Logger): Promise<INestApplication> {
  const app = await NestFactory.create<NestExpressApplication>(AppModule.forRoot({ config, rootLogger }), {
    bufferLogs: true,
    bodyParser: false,
  });
  app.useLogger(app.get(NestPinoLogger));
  app.disable('x-powered-by');
  app.set('trust proxy', true); // detrás del balanceador de Cloud Run / API Gateway
  app.useBodyParser('json', { limit: BODY_LIMIT, type: ['application/json', 'application/*+json'] });

  if (config.CORS_ORIGINS.length > 0) {
    // Para un frontend (p.ej. React) servido desde otro origen; deshabilitado por defecto.
    app.enableCors({ origin: config.CORS_ORIGINS, methods: ['GET', 'POST', 'PUT'], allowedHeaders: ['Content-Type', 'X-Tenant-Id', 'X-Request-Id'] });
  }

  const metrics = app.get(PrometheusMetrics);
  app.use((req: Request, res: Response, next: NextFunction) => {
    // Cabeceras de seguridad para una API JSON
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cache-Control', 'no-store');
    if (!req.path.startsWith('/docs')) {
      res.setHeader('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'");
    }
    // 415 si un POST/PUT con cuerpo no es JSON (en vez de un 400 confuso por cuerpo vacío)
    const hasBody = Number(req.headers['content-length'] ?? 0) > 0 || req.headers['transfer-encoding'] !== undefined;
    if ((req.method === 'POST' || req.method === 'PUT') && hasBody && !req.is(['application/json', 'application/*+json'])) {
      res.status(415).type('application/problem+json').json({
        type: 'https://tracking-notifier.domina.dev/problemas/tipo-contenido-no-soportado',
        title: 'Tipo de contenido no soportado',
        status: 415,
        detail: 'Use Content-Type: application/json',
        instance: req.path,
        code: 'TIPO_CONTENIDO_NO_SOPORTADO',
      });
      return;
    }
    const end = metrics.httpRequests.startTimer();
    res.on('finish', () => {
      const route = (req.route as { path?: string } | undefined)?.path ?? 'no_encontrada';
      end({ method: req.method, route: `${req.baseUrl}${route}`, status: String(res.statusCode) });
    });
    next();
  });

  app.useGlobalFilters(new ProblemDetailsFilter(rootLogger));
  mountApiDocs(app);
  app.enableShutdownHooks();
  return app;
}

/** Contract-first: la documentación se sirve desde docs/openapi.yaml (fuente de verdad del contrato). */
function mountApiDocs(app: INestApplication): void {
  const specPath = resolve(process.cwd(), 'docs', 'openapi.yaml');
  if (!existsSync(specPath)) return;
  const document = parseYaml(readFileSync(specPath, 'utf8'));
  SwaggerModule.setup('docs', app, document, { jsonDocumentUrl: 'docs/openapi.json', yamlDocumentUrl: 'docs/openapi.yaml' });
}
