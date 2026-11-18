import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseEnv } from 'node:util';

// Carga variables locales de prueba (archivo ignorado por git). En CI llegan como variables de entorno reales,
// que tienen prioridad. Se asignan explícitamente porque Jest aísla process.env por entorno de prueba.
const envFile = resolve(__dirname, '..', '..', '.env.test');
if (existsSync(envFile)) {
  for (const [key, value] of Object.entries(parseEnv(readFileSync(envFile, 'utf8')))) {
    process.env[key] ??= value;
  }
}
process.env.LOG_LEVEL ??= 'silent';
