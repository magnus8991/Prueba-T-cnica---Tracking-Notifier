// Webhook de prueba: imprime lo que recibe, verifica la firma HMAC (Standard Webhooks)
// y permite simular fallas para demostrar los reintentos. Sin dependencias.
//
//   POST /hook          → recibe notificaciones del servicio
//   POST /_config       → {"secret":"whsec_...","failNext":3,"delayMs":0,"status":500}
//   GET  /_received     → últimas notificaciones recibidas (para el smoke test)
import { createHmac, timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';

const PORT = Number(process.env.PORT ?? 8080);
const state = {
  secret: process.env.WEBHOOK_SECRET ?? null,
  failNext: Number(process.env.FAIL_FIRST_N ?? 0),
  failStatus: 500,
  delayMs: 0,
  received: [],
};

function verify(secret, id, timestamp, body, header) {
  if (!secret || !header) return null;
  const key = Buffer.from(secret.replace(/^whsec_/, ''), 'base64');
  const expected = Buffer.from(`v1,${createHmac('sha256', key).update(`${id}.${timestamp}.${body}`).digest('base64')}`);
  return header.split(' ').some((sig) => {
    const candidate = Buffer.from(sig);
    return candidate.length === expected.length && timingSafeEqual(candidate, expected);
  });
}

const readBody = (req) =>
  new Promise((resolve) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
  });

const json = (res, status, payload) => res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(payload));

createServer(async (req, res) => {
  const body = await readBody(req);

  if (req.method === 'POST' && req.url === '/_config') {
    const cfg = body ? JSON.parse(body) : {};
    if ('secret' in cfg) state.secret = cfg.secret;
    if ('failNext' in cfg) state.failNext = Number(cfg.failNext);
    if ('status' in cfg) state.failStatus = Number(cfg.status);
    if ('delayMs' in cfg) state.delayMs = Number(cfg.delayMs);
    if (cfg.reset) state.received = [];
    return json(res, 200, { ok: true, failNext: state.failNext, delayMs: state.delayMs, secretConfigured: Boolean(state.secret) });
  }
  if (req.method === 'GET' && req.url === '/_received') {
    return json(res, 200, state.received);
  }
  if (req.method === 'GET' && req.url === '/health') {
    return json(res, 200, { status: 'ok' });
  }
  if (req.method !== 'POST') return json(res, 405, { error: 'method not allowed' });

  const id = req.headers['webhook-id'];
  const timestamp = req.headers['webhook-timestamp'];
  const signatureValid = verify(state.secret, id, timestamp, body, req.headers['webhook-signature']);
  const shouldFail = state.failNext > 0;
  if (shouldFail) state.failNext -= 1;
  const status = shouldFail ? state.failStatus : 200;

  const entry = {
    receivedAt: new Date().toISOString(),
    webhookId: id,
    attempt: Number(req.headers['x-delivery-attempt']),
    signatureValid,
    respondedWith: status,
    payload: JSON.parse(body || '{}'),
  };
  state.received = [entry, ...state.received].slice(0, 200);
  // Datos 100% ficticios: el receptor de prueba imprime el payload para la demo.
  console.log(JSON.stringify({ message: 'webhook recibido', ...entry }));

  setTimeout(() => json(res, status, { received: true }), state.delayMs);
}).listen(PORT, () => console.log(JSON.stringify({ message: `webhook-receiver escuchando en :${PORT}` })));
