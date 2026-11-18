/** Ejecuta fn y devuelve el error lanzado (falla la prueba si no lanza). */
export function captureError(fn: () => unknown): Error & { code?: string } {
  try {
    fn();
  } catch (error) {
    return error as Error & { code?: string };
  }
  throw new Error('Se esperaba que la función lanzara un error');
}

export async function captureAsyncError(fn: () => Promise<unknown>): Promise<Error & { code?: string }> {
  try {
    await fn();
  } catch (error) {
    return error as Error & { code?: string };
  }
  throw new Error('Se esperaba que la promesa fuera rechazada');
}
