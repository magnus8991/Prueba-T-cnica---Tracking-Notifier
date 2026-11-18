import { ExponentialBackoffPolicy } from '../../../src/domain/notification/retry-policy';

describe('ExponentialBackoffPolicy', () => {
  const options = { maxAttempts: 5, baseDelayMs: 2000, maxDelayMs: 60_000 };

  it('sin jitter máximo duplica la espera en cada intento: 2s, 4s, 8s, 16s', () => {
    const policy = new ExponentialBackoffPolicy(options, () => 0.9999999);
    expect([1, 2, 3, 4].map((n) => policy.delayAfterFailedAttempt(n))).toEqual([2000, 4000, 8000, 16000]);
  });

  it('con jitter mínimo usa la mitad del techo: 1s, 2s, 4s, 8s', () => {
    const policy = new ExponentialBackoffPolicy(options, () => 0);
    expect([1, 2, 3, 4].map((n) => policy.delayAfterFailedAttempt(n))).toEqual([1000, 2000, 4000, 8000]);
  });

  it('la espera es creciente para cualquier valor aleatorio (propiedad)', () => {
    for (let i = 0; i < 500; i++) {
      const values = [Math.random(), Math.random(), Math.random(), Math.random()];
      let call = 0;
      const policy = new ExponentialBackoffPolicy(options, () => values[call++ % values.length]!);
      const delays = [1, 2, 3, 4].map((n) => policy.delayAfterFailedAttempt(n));
      for (let k = 1; k < delays.length; k++) {
        expect(delays[k]!).toBeGreaterThanOrEqual(delays[k - 1]!);
      }
    }
  });

  it('respeta el tope máximo', () => {
    const policy = new ExponentialBackoffPolicy({ ...options, maxDelayMs: 5000 }, () => 0.9999999);
    expect(policy.delayAfterFailedAttempt(10)).toBe(5000);
  });

  it('valida su configuración', () => {
    expect(() => new ExponentialBackoffPolicy({ ...options, maxAttempts: 0 })).toThrow(RangeError);
    expect(() => new ExponentialBackoffPolicy({ ...options, maxDelayMs: 1 })).toThrow(RangeError);
  });
});
