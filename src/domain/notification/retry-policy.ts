/** Fuente de aleatoriedad inyectable: devuelve un número en [0, 1). */
export type RandomSource = () => number;

export interface RetryPolicy {
  readonly maxAttempts: number;
  /** Espera antes del siguiente intento, dado el número del intento que acaba de fallar (1-based). */
  delayAfterFailedAttempt(attemptNumber: number): number;
}

export interface ExponentialBackoffOptions {
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
  multiplier?: number;
}

/**
 * Backoff exponencial con "equal jitter": delay ∈ [e/2, e], con e = base·mult^(n-1).
 * El intervalo del intento n+1 empieza donde termina el del intento n, así que la
 * espera nunca decrece (espera creciente) y además se evita la sincronización de
 * reintentos entre muchos tenants (thundering herd).
 */
export class ExponentialBackoffPolicy implements RetryPolicy {
  readonly maxAttempts: number;
  private readonly baseDelayMs: number;
  private readonly maxDelayMs: number;
  private readonly multiplier: number;

  constructor(
    options: ExponentialBackoffOptions,
    private readonly random: RandomSource = Math.random,
  ) {
    if (!Number.isInteger(options.maxAttempts) || options.maxAttempts < 1) {
      throw new RangeError('maxAttempts debe ser un entero >= 1');
    }
    if (options.baseDelayMs < 0 || options.maxDelayMs < options.baseDelayMs) {
      throw new RangeError('Se requiere 0 <= baseDelayMs <= maxDelayMs');
    }
    this.maxAttempts = options.maxAttempts;
    this.baseDelayMs = options.baseDelayMs;
    this.maxDelayMs = options.maxDelayMs;
    this.multiplier = options.multiplier ?? 2;
  }

  delayAfterFailedAttempt(attemptNumber: number): number {
    const exponent = Math.max(0, attemptNumber - 1);
    const ceiling = Math.min(this.maxDelayMs, this.baseDelayMs * this.multiplier ** exponent);
    const half = ceiling / 2;
    return Math.round(half + this.random() * half);
  }
}
