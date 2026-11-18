import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

// Carga variables locales de prueba (archivo ignorado por git). En CI llegan como variables de entorno.
const envFile = resolve(__dirname, '..', '..', '.env.test');
if (existsSync(envFile)) {
  process.loadEnvFile(envFile);
}
process.env.LOG_LEVEL ??= 'silent';
