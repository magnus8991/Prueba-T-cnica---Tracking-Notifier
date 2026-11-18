#!/usr/bin/env node
// Smoke / E2E post-despliegue contra el stack REAL en ejecución (docker compose o despliegue).
//
//   BASE_URL       URL del servicio            (default http://localhost:8080)
//   RECEIVER_URL   URL del webhook de prueba   (default http://localhost:9090)
//   WEBHOOK_TARGET URL del receptor vista DESDE el servicio (default http://webhook-receiver:8080/hook)
//   SMOKE_SKIP_RETRIES=1 omite el escenario de reintentos (~15-30 s con los tiempos por defecto)
import { randomUUID } from 'node:crypto';

const BASE_URL = process.env.BASE_URL ?? 'http://localhost:8080';
const RECEIVER_URL = process.env.RECEIVER_URL ?? 'http://localhost:9090';
const WEBHOOK_TARGET = process.env.WEBHOOK_TARGET ?? 'http://webhook-receiver:8080/hook';
const TENANT = `smoke-${randomUUID().slice(0, 8)}`;
const results = [];

async function call(method, path, { body, tenant = TENANT, base = BASE_URL } = {}) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...(tenant ? { 'x-tenant-id': tenant } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, headers: res.headers, body: parseJson(text) };
}

function parseJson(text) {
  try {
    return text ? JSON.parse(text) : null;
  } catch {
    return text;
  }
}

async function waitFor(description, probe, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const value = await probe();
      if (value) return value;
    } catch {
      /* reintentar */
    }
    if (Date.now() > deadline) throw new Error(`Timeout esperando: ${description}`);
    await new Promise((r) => setTimeout(r, 300));
  }
}

async function step(name, fn) {
  const started = Date.now();
  try {
    await fn();
    results.push({ paso: name, resultado: 'PASS', ms: Date.now() - started });
  } catch (error) {
    results.push({ paso: name, resultado: 'FAIL', ms: Date.now() - started, detalle: error.message });
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const event = (estado, fechaEvento, eventId = randomUUID()) => ({ eventId, estado, fechaEvento, observacion: 'Dato ficticio smoke' });
// Fechas relativas al reloj real (el servicio rechaza fechaEvento en el futuro).
const hoursAgo = (h) => new Date(Date.now() - h * 3_600_000).toISOString();
const notifications = async (query = '') => (await call('GET', `/v1/notificaciones${query}`)).body.items;

await step('Servicio listo (/health/ready)', () =>
  waitFor('readiness', async () => (await call('GET', '/health/ready', { tenant: null })).status === 200, 90_000),
);
await step('Webhook receiver disponible', () => waitFor('receiver', async () => (await fetch(`${RECEIVER_URL}/health`)).ok, 30_000));

let secret;
await step('RF3: configurar webhook → 201 con secreto', async () => {
  const res = await call('PUT', '/v1/webhook', { body: { url: WEBHOOK_TARGET } });
  assert(res.status === 201, `status ${res.status}: ${JSON.stringify(res.body)}`);
  secret = res.body.secreto;
  assert(secret?.startsWith('whsec_'), 'no se devolvió el secreto');
  await fetch(`${RECEIVER_URL}/_config`, { method: 'POST', body: JSON.stringify({ secret, failNext: 0, delayMs: 0 }) });
});

const created = event('CREADA', hoursAgo(10));
await step('RF1: registrar evento → 201', async () => {
  const res = await call('POST', '/v1/guias/SMOKE-0001/eventos', { body: created });
  assert(res.status === 201, `status ${res.status}: ${JSON.stringify(res.body)}`);
});

await step('RF1: mismo eventId → 200 idempotente', async () => {
  const res = await call('POST', '/v1/guias/SMOKE-0001/eventos', { body: created });
  assert(res.status === 200 && res.headers.get('idempotent-replayed') === 'true', `status ${res.status}`);
});

await step('RF4: webhook recibido con firma HMAC válida y notificación ENVIADA', async () => {
  const entry = await waitFor(
    'webhook recibido',
    async () => (await (await fetch(`${RECEIVER_URL}/_received`)).json()).find((e) => e.webhookId === created.eventId),
    15_000,
  );
  assert(entry.signatureValid === true, 'firma HMAC inválida');
  await waitFor('notificación ENVIADA', async () => (await notifications()).some((n) => n.eventId === created.eventId && n.estado === 'ENVIADA'), 15_000);
  const all = (await (await fetch(`${RECEIVER_URL}/_received`)).json()).filter((e) => e.webhookId === created.eventId);
  assert(all.length === 1, `el evento idempotente generó ${all.length} envíos`);
});

await step('RF1: ENTREGADA → 201 y luego EN_RUTA → 409 (estado terminal)', async () => {
  const delivered = await call('POST', '/v1/guias/SMOKE-0001/eventos', { body: event('ENTREGADA', hoursAgo(3)) });
  assert(delivered.status === 201, `ENTREGADA status ${delivered.status}`);
  const after = await call('POST', '/v1/guias/SMOKE-0001/eventos', { body: event('EN_RUTA', hoursAgo(2)) });
  assert(after.status === 409 && after.body.code === 'GUIA_EN_ESTADO_TERMINAL', `status ${after.status} ${after.body?.code}`);
  assert(after.headers.get('content-type')?.includes('application/problem+json'), 'el error no es problem+json');
});

await step('RF2: historial cronológico y estado actual', async () => {
  const res = await call('GET', '/v1/guias/SMOKE-0001');
  assert(res.status === 200, `status ${res.status}`);
  assert(res.body.estadoActual === 'ENTREGADA', `estadoActual ${res.body.estadoActual}`);
  assert(res.body.eventos.map((e) => e.estado).join(',') === 'CREADA,ENTREGADA', `eventos ${res.body.eventos.map((e) => e.estado)}`);
});

await step('RF2: aislamiento por tenant (otro tenant → 404)', async () => {
  const res = await call('GET', '/v1/guias/SMOKE-0001', { tenant: `${TENANT}-otro` });
  assert(res.status === 404, `status ${res.status}`);
});

await step('Validación: cuerpo inválido → 400 problem+json', async () => {
  const res = await call('POST', '/v1/guias/SMOKE-0002/eventos', { body: { eventId: 'x', estado: 'PERDIDA' } });
  assert(res.status === 400 && res.body.code === 'VALIDACION_FALLIDA' && res.body.errors.length >= 2, `status ${res.status}`);
});

if (process.env.SMOKE_SKIP_RETRIES !== '1') {
  await step('RF4: webhook caído → 5 intentos → FALLIDA → reintento manual → ENVIADA', async () => {
    // Esperar a que no queden entregas en curso: si no, una entrega previa consumiría una de las fallas simuladas.
    await waitFor('cola vacía', async () => (await notifications()).every((n) => n.estado === 'ENVIADA' || n.estado === 'FALLIDA'), 30_000);
    await fetch(`${RECEIVER_URL}/_config`, { method: 'POST', body: JSON.stringify({ failNext: 5, status: 503 }) });
    const failing = event('EN_RUTA', hoursAgo(9));
    assert((await call('POST', '/v1/guias/SMOKE-0003/eventos', { body: failing })).status === 201, 'registro falló');

    const failed = await waitFor(
      'notificación FALLIDA',
      async () => (await notifications('?estado=FALLIDA')).find((n) => n.eventId === failing.eventId),
      90_000,
    );
    assert(failed.intentos === 5 && failed.ultimoHttpStatus === 503, `intentos ${failed.intentos}`);

    const retry = await call('POST', `/v1/notificaciones/${failed.id}/reintentar`);
    assert(retry.status === 202, `reintentar status ${retry.status}`);
    await waitFor('ENVIADA tras reintento', async () => (await notifications()).some((n) => n.id === failed.id && n.estado === 'ENVIADA'), 15_000);
  });
}

await step('Operación: métricas Prometheus y OpenAPI', async () => {
  const metrics = await fetch(`${BASE_URL}/metrics`);
  assert(metrics.ok && (await metrics.text()).includes('webhook_deliveries_total'), 'métricas no disponibles');
  assert((await fetch(`${BASE_URL}/docs/openapi.json`)).ok, 'OpenAPI no disponible');
});

console.table(results);
const failed = results.filter((r) => r.resultado === 'FAIL');
if (process.env.GITHUB_ACTIONS === 'true') {
  // Anotaciones visibles en la página del run de GitHub Actions.
  for (const f of failed) console.log(`::error title=Smoke - ${f.paso}::${String(f.detalle).replace(/\r?\n/g, ' ')}`);
}
console.log(failed.length === 0 ? `\nSMOKE OK (${results.length} pasos, tenant ${TENANT})` : `\nSMOKE FALLÓ: ${failed.length} de ${results.length} pasos`);
process.exit(failed.length === 0 ? 0 : 1);
