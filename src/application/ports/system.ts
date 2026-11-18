// Puertos de "sistema": permiten pruebas deterministas y no acoplan el núcleo a Node.

export interface Clock {
  now(): Date;
}

export interface IdGenerator {
  uuid(): string;
}

export interface SecretGenerator {
  /** Secreto HMAC con formato Standard Webhooks: "whsec_" + base64(24..64 bytes aleatorios). */
  generate(): string;
}

/** Señal para despertar al despachador cuando hay trabajo nuevo (reduce latencia sin esperar al polling). */
export interface WorkSignal {
  notify(): void;
}

export type LogContext = Record<string, string | number | boolean | null | undefined>;

/** Logger estructurado. El contexto NUNCA debe incluir datos personales ni secretos. */
export interface AppLogger {
  info(message: string, context?: LogContext): void;
  warn(message: string, context?: LogContext): void;
  error(message: string, context?: LogContext): void;
}

export type DeliveryOutcome = 'ENVIADA' | 'REINTENTO_PROGRAMADO' | 'FALLIDA' | 'DESCARTADA';

export interface DeliveryMetrics {
  recordDelivery(outcome: DeliveryOutcome, durationMs: number): void;
}
