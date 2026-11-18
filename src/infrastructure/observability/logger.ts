import { IncomingMessage } from 'node:http';
import { randomUUID } from 'node:crypto';
import pino, { Logger, LoggerOptions } from 'pino';
import { AppLogger, LogContext } from '../../application/ports/system';
import { AppConfig } from '../config/env';

/** Mapeo de niveles pino → severidad de Google Cloud Logging. */
const GCP_SEVERITY: Record<string, string> = {
  trace: 'DEBUG',
  debug: 'DEBUG',
  info: 'INFO',
  warn: 'WARNING',
  error: 'ERROR',
  fatal: 'CRITICAL',
};

/**
 * Rutas que se redactan SIEMPRE. Defensa en profundidad: aunque el código no
 * loguea cuerpos, si alguien lo hiciera por error, los datos sensibles no salen.
 */
export const REDACT_PATHS = [
  'req.headers.authorization',
  'req.headers.cookie',
  'req.headers["x-api-key"]',
  'req.body',
  'res.headers["set-cookie"]',
  '*.secret',
  '*.secreto',
  '*.observacion',
  '*.observation',
  '*.password',
  '*.webhookUrl',
];

export function pinoOptions(config: Pick<AppConfig, 'LOG_LEVEL' | 'LOG_PRETTY'>): LoggerOptions {
  return {
    level: config.LOG_LEVEL,
    messageKey: 'message', // campo que Cloud Logging muestra como mensaje
    base: { service: 'tracking-notifier' },
    timestamp: pino.stdTimeFunctions.isoTime,
    redact: { paths: REDACT_PATHS, censor: '[REDACTED]' },
    formatters: {
      level: (label) => ({ level: label, severity: GCP_SEVERITY[label] ?? 'DEFAULT' }),
    },
    transport: config.LOG_PRETTY ? { target: 'pino-pretty', options: { messageKey: 'message', singleLine: true } } : undefined,
  };
}

export function createRootLogger(config: Pick<AppConfig, 'LOG_LEVEL' | 'LOG_PRETTY'>): Logger {
  return pino(pinoOptions(config));
}

/** Correlación: respeta X-Request-Id entrante (si es seguro) o genera uno nuevo. */
export function requestIdFrom(req: IncomingMessage): string {
  const incoming = req.headers['x-request-id'];
  return typeof incoming === 'string' && /^[A-Za-z0-9._-]{8,128}$/.test(incoming) ? incoming : randomUUID();
}

/**
 * Enlaza el log con Cloud Trace cuando corre en GCP (cabecera X-Cloud-Trace-Context
 * o traceparent W3C).
 */
export function gcpTraceFields(req: IncomingMessage, projectId: string | undefined): Record<string, string> {
  if (!projectId) return {};
  const cloud = req.headers['x-cloud-trace-context'];
  const traceparent = req.headers['traceparent'];
  const traceId =
    typeof cloud === 'string' ? cloud.split('/')[0] : typeof traceparent === 'string' ? traceparent.split('-')[1] : undefined;
  return traceId && /^[0-9a-f]{32}$/i.test(traceId) ? { 'logging.googleapis.com/trace': `projects/${projectId}/traces/${traceId}` } : {};
}

/** Adaptador del puerto AppLogger sobre pino. */
export class PinoAppLogger implements AppLogger {
  constructor(private readonly logger: Logger) {}
  info(message: string, context: LogContext = {}): void {
    this.logger.info(context, message);
  }
  warn(message: string, context: LogContext = {}): void {
    this.logger.warn(context, message);
  }
  error(message: string, context: LogContext = {}): void {
    this.logger.error(context, message);
  }
}
