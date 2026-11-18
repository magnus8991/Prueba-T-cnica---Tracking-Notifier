import { INestApplication } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import request from 'supertest';
import { verifyWebhookSignature } from '../../src/infrastructure/webhook/hmac-signer';
import { createMigratedTestPool, resetDatabase } from '../support/database';
import { eventually, LogCapture, startE2eApp } from '../support/e2e-app';
import { FakeWebhookServer } from '../support/fake-webhook-server';

/**
 * E2E: la aplicación real (Nest + adaptadores) contra PostgreSQL real y un webhook HTTP real.
 * Cubre los requisitos funcionales RF1–RF4 y los técnicos visibles por HTTP.
 */
describe('tracking-notifier E2E', () => {
  let app: INestApplication;
  let logs: LogCapture;
  let pool: Pool;
  const webhook = new FakeWebhookServer();
  let webhookUrl: string;

  const TENANT = 'banco-ficticio';
  const OTHER_TENANT = 'retail-ficticio';
  const api = () => request(app.getHttpServer());

  const event = (overrides: Record<string, unknown> = {}) => ({
    eventId: randomUUID(),
    estado: 'CREADA',
    fechaEvento: '2026-11-18T08:00:00-05:00',
    observacion: 'Dato ficticio de prueba',
    ...overrides,
  });

  const postEvent = (guia: string, body: object, tenant = TENANT) =>
    api().post(`/v1/guias/${guia}/eventos`).set('X-Tenant-Id', tenant).send(body);

  const configureWebhook = (tenant = TENANT, url = webhookUrl) => api().put('/v1/webhook').set('X-Tenant-Id', tenant).send({ url });

  const notifications = async (tenant = TENANT, query = '') =>
    (await api().get(`/v1/notificaciones${query}`).set('X-Tenant-Id', tenant).expect(200)).body.items as Array<Record<string, unknown>>;

  beforeAll(async () => {
    pool = await createMigratedTestPool(2);
    webhookUrl = await webhook.start();
    ({ app, logs } = await startE2eApp());
  });

  afterAll(async () => {
    await app?.close();
    await webhook.stop();
    await pool?.end();
  });

  beforeEach(async () => {
    await resetDatabase(pool);
    webhook.received.length = 0;
    webhook.responder = () => ({ status: 200 });
  });

  describe('RF1 · Registrar evento', () => {
    it('201: registra el evento, devuelve Location, X-Request-Id y el estado actual', async () => {
      const body = event();
      const res = await postEvent('GUIA-0001', body).expect(201);

      expect(res.headers.location).toBe('/v1/guias/GUIA-0001');
      expect(res.headers['x-request-id']).toBeDefined();
      expect(res.body).toMatchObject({
        eventId: body.eventId,
        numeroGuia: 'GUIA-0001',
        estado: 'CREADA',
        fechaEvento: '2026-11-18T13:00:00.000Z',
        observacion: 'Dato ficticio de prueba',
        estadoActualGuia: 'CREADA',
      });
    });

    it('idempotencia: el mismo eventId responde 200 con Idempotent-Replayed y no duplica evento ni notificación', async () => {
      await configureWebhook().expect(201);
      const body = event();
      await postEvent('GUIA-0001', body).expect(201);
      const replay = await postEvent('GUIA-0001', body).expect(200);

      expect(replay.headers['idempotent-replayed']).toBe('true');
      await eventually(notifications, (items) => items[0]?.estado === 'ENVIADA');
      expect(await notifications()).toHaveLength(1);
      await new Promise((r) => setTimeout(r, 200));
      expect(webhook.received).toHaveLength(1);
    });

    it('idempotencia: el mismo eventId con otro contenido → 409 EVENT_ID_CONFLICTO', async () => {
      const body = event();
      await postEvent('GUIA-0001', body).expect(201);
      const res = await postEvent('GUIA-0001', { ...body, estado: 'EN_RUTA' }).expect(409);
      expect(res.body.code).toBe('EVENT_ID_CONFLICTO');
    });

    it.each(['ENTREGADA', 'DEVUELTA'])('una guía %s rechaza nuevos estados con 409 problem+json', async (terminal) => {
      await postEvent('GUIA-0001', event({ estado: 'EN_RUTA' })).expect(201);
      await postEvent('GUIA-0001', event({ estado: terminal, fechaEvento: '2026-11-18T10:00:00Z' })).expect(201);

      const res = await postEvent('GUIA-0001', event({ estado: 'EN_RUTA', fechaEvento: '2026-11-18T11:00:00Z' })).expect(409);
      expect(res.headers['content-type']).toMatch(/application\/problem\+json/);
      expect(res.body).toMatchObject({ status: 409, code: 'GUIA_EN_ESTADO_TERMINAL', instance: '/v1/guias/GUIA-0001/eventos' });
      expect(res.body.requestId).toBe(res.headers['x-request-id']);
    });

    it('el envío NO bloquea la respuesta: con un webhook lento, el POST responde de inmediato', async () => {
      await configureWebhook().expect(201);
      webhook.responder = () => ({ status: 200, delayMs: 350 });

      const started = Date.now();
      await postEvent('GUIA-0001', event()).expect(201);
      expect(Date.now() - started).toBeLessThan(300);

      await eventually(notifications, (items) => items[0]?.estado === 'ENVIADA');
    });
  });

  describe('Validación y formato único de error (RFC 9457)', () => {
    it.each([
      ['falta eventId', { estado: 'CREADA', fechaEvento: '2026-11-18T08:00:00Z' }, 'eventId'],
      ['eventId no UUID', { eventId: 'abc', estado: 'CREADA', fechaEvento: '2026-11-18T08:00:00Z' }, 'eventId'],
      ['estado desconocido', { eventId: randomUUID(), estado: 'PERDIDA', fechaEvento: '2026-11-18T08:00:00Z' }, 'estado'],
      ['fecha sin zona horaria', { eventId: randomUUID(), estado: 'CREADA', fechaEvento: '2026-11-18T08:00:00' }, 'fechaEvento'],
      ['fecha inválida', { eventId: randomUUID(), estado: 'CREADA', fechaEvento: '18/11/2026' }, 'fechaEvento'],
      ['observación muy larga', { eventId: randomUUID(), estado: 'CREADA', fechaEvento: '2026-11-18T08:00:00Z', observacion: 'x'.repeat(501) }, 'observacion'],
      ['campo desconocido', { eventId: randomUUID(), estado: 'CREADA', fechaEvento: '2026-11-18T08:00:00Z', tenant: 'otro' }, '(body)'],
    ])('400 VALIDACION_FALLIDA: %s', async (_case, body, path) => {
      const res = await postEvent('GUIA-0001', body).expect(400);
      expect(res.headers['content-type']).toMatch(/application\/problem\+json/);
      expect(res.body).toMatchObject({ status: 400, code: 'VALIDACION_FALLIDA', type: expect.stringContaining('validacion-fallida') });
      expect(res.body.errors.map((e: { path: string }) => e.path)).toContain(path);
    });

    it('400 TENANT_INVALIDO si falta o es inválida la cabecera X-Tenant-Id', async () => {
      expect((await api().post('/v1/guias/GUIA-0001/eventos').send(event()).expect(400)).body.code).toBe('TENANT_INVALIDO');
      expect((await postEvent('GUIA-0001', event(), 'tenant con espacios').expect(400)).body.code).toBe('TENANT_INVALIDO');
    });

    it('400 número de guía inválido', async () => {
      expect((await postEvent('GUIA%2F01', event()).expect(400)).body.errors[0].path).toBe('numeroGuia');
    });

    it('400 JSON_MALFORMADO', async () => {
      const res = await api().post('/v1/guias/GUIA-0001/eventos').set('X-Tenant-Id', TENANT).set('Content-Type', 'application/json').send('{"eventId":').expect(400);
      expect(res.body.code).toBe('JSON_MALFORMADO');
    });

    it('415 si el cuerpo no es JSON', async () => {
      const res = await api().post('/v1/guias/GUIA-0001/eventos').set('X-Tenant-Id', TENANT).set('Content-Type', 'text/plain').send('hola').expect(415);
      expect(res.body.code).toBe('TIPO_CONTENIDO_NO_SOPORTADO');
    });

    it('413 si el cuerpo excede el límite', async () => {
      const res = await postEvent('GUIA-0001', { ...event(), observacion: 'x'.repeat(20_000) }).expect(413);
      expect(res.body.code).toBe('CUERPO_DEMASIADO_GRANDE');
    });

    it('404 en rutas inexistentes con el mismo formato de error', async () => {
      const res = await api().get('/v1/no-existe').expect(404);
      expect(res.body).toMatchObject({ status: 404, code: 'RUTA_NO_ENCONTRADA' });
    });

    it('cabeceras de seguridad y sin X-Powered-By', async () => {
      const res = await api().get('/health/live').expect(200);
      expect(res.headers['x-powered-by']).toBeUndefined();
      expect(res.headers['x-content-type-options']).toBe('nosniff');
      expect(res.headers['cache-control']).toBe('no-store');
    });
  });

  describe('RF2 · Consultar historial', () => {
    it('devuelve estado actual y eventos en orden cronológico (aunque lleguen desordenados)', async () => {
      await postEvent('GUIA-0002', event({ estado: 'EN_RUTA', fechaEvento: '2026-11-18T12:00:00Z' })).expect(201);
      await postEvent('GUIA-0002', event({ estado: 'CREADA', fechaEvento: '2026-11-18T07:00:00Z' })).expect(201);
      await postEvent('GUIA-0002', event({ estado: 'EN_RUTA', fechaEvento: '2026-11-18T09:30:00Z' })).expect(201);

      const res = await api().get('/v1/guias/GUIA-0002').set('X-Tenant-Id', TENANT).expect(200);
      expect(res.body.estadoActual).toBe('EN_RUTA');
      expect(res.body.fechaEstadoActual).toBe('2026-11-18T12:00:00.000Z');
      expect(res.body.eventos.map((e: { fechaEvento: string }) => e.fechaEvento)).toEqual([
        '2026-11-18T07:00:00.000Z',
        '2026-11-18T09:30:00.000Z',
        '2026-11-18T12:00:00.000Z',
      ]);
    });

    it('AISLAMIENTO: un tenant nunca ve guías, notificaciones ni webhook de otro tenant', async () => {
      await configureWebhook(TENANT).expect(201);
      await postEvent('GUIA-0003', event()).expect(201);
      const [own] = await notifications(TENANT);

      expect((await api().get('/v1/guias/GUIA-0003').set('X-Tenant-Id', OTHER_TENANT).expect(404)).body.code).toBe('RECURSO_NO_ENCONTRADO');
      expect(await notifications(OTHER_TENANT)).toEqual([]);
      await api().get(`/v1/notificaciones/${own!.id}`).set('X-Tenant-Id', OTHER_TENANT).expect(404);
      await api().post(`/v1/notificaciones/${own!.id}/reintentar`).set('X-Tenant-Id', OTHER_TENANT).expect(404);
      await api().get('/v1/webhook').set('X-Tenant-Id', OTHER_TENANT).expect(404);
    });

    it('la misma guía en dos tenants son guías independientes', async () => {
      await postEvent('GUIA-0004', event({ estado: 'ENTREGADA' }), TENANT).expect(201);
      await postEvent('GUIA-0004', event({ estado: 'EN_RUTA' }), OTHER_TENANT).expect(201);
      expect((await api().get('/v1/guias/GUIA-0004').set('X-Tenant-Id', OTHER_TENANT).expect(200)).body.estadoActual).toBe('EN_RUTA');
    });
  });

  describe('RF3 · Configurar webhook', () => {
    it('crea (201 con secreto una única vez), actualiza (200 sin secreto) y consulta sin exponer el secreto', async () => {
      const created = await configureWebhook().expect(201);
      expect(created.body.secreto).toMatch(/^whsec_/);

      const updated = await api().put('/v1/webhook').set('X-Tenant-Id', TENANT).send({ url: `${webhookUrl}?v=2` }).expect(200);
      expect(updated.body.secreto).toBeUndefined();

      const current = await api().get('/v1/webhook').set('X-Tenant-Id', TENANT).expect(200);
      expect(current.body.url).toBe(`${webhookUrl}?v=2`);
      expect(current.body.secreto).toBeUndefined();

      const rotated = await api().put('/v1/webhook').set('X-Tenant-Id', TENANT).send({ url: webhookUrl, rotarSecreto: true }).expect(200);
      expect(rotated.body.secreto).toMatch(/^whsec_/);
      expect(rotated.body.secreto).not.toBe(created.body.secreto);
    });

    it.each(['ftp://cliente.example.com', 'https://user:pass@cliente.example.com/', 'no-es-url'])('400 con URL inválida %s', async (url) => {
      expect((await api().put('/v1/webhook').set('X-Tenant-Id', TENANT).send({ url }).expect(400)).body.code).toBe('URL_WEBHOOK_INVALIDA');
    });
  });

  describe('RF4 · Notificar al cliente', () => {
    it('envía un POST firmado (HMAC verificable) con el evento y la marca ENVIADA', async () => {
      const { body: hook } = await configureWebhook().expect(201);
      const body = event({ estado: 'EN_RUTA' });
      await postEvent('GUIA-0005', body).expect(201);
      await webhook.waitFor(1);

      const [received] = webhook.received;
      expect(JSON.parse(received!.body)).toMatchObject({
        type: 'guia.estado_actualizado',
        eventId: body.eventId,
        numeroGuia: 'GUIA-0005',
        estado: 'EN_RUTA',
      });
      expect(received!.headers['webhook-id']).toBe(body.eventId);
      expect(
        verifyWebhookSignature(hook.secreto, body.eventId, Number(received!.headers['webhook-timestamp']), received!.body, String(received!.headers['webhook-signature'])),
      ).toBe(true);

      const [n] = await eventually(notifications, (items) => items[0]?.estado === 'ENVIADA');
      expect(n).toMatchObject({ intentos: 1, ultimoHttpStatus: 200 });
    });

    it('webhook caído (500): 5 intentos con espera creciente → FALLIDA, consultable, y reintento manual', async () => {
      await configureWebhook().expect(201);
      webhook.responder = () => ({ status: 500 });
      await postEvent('GUIA-0006', event()).expect(201);

      const [failed] = await eventually(
        () => notifications(TENANT, '?estado=FALLIDA'),
        (items) => items.length === 1,
      );
      expect(failed).toMatchObject({ estado: 'FALLIDA', intentos: 5, maxIntentos: 5, ultimoError: 'HTTP_ERROR', ultimoHttpStatus: 500 });
      expect(webhook.received).toHaveLength(5);
      expect(webhook.received.map((r) => r.headers['x-delivery-attempt'])).toEqual(['1', '2', '3', '4', '5']);

      // Espera creciente entre intentos
      const gaps = webhook.received.slice(1).map((r, i) => r.receivedAt - webhook.received[i]!.receivedAt);
      for (let i = 1; i < gaps.length; i++) expect(gaps[i]!).toBeGreaterThanOrEqual(gaps[i - 1]! - 15);

      const detail = await api().get(`/v1/notificaciones/${failed!.id}`).set('X-Tenant-Id', TENANT).expect(200);
      expect(detail.body.historialIntentos).toHaveLength(5);

      // Reintento manual cuando el cliente se recupera
      webhook.responder = () => ({ status: 200 });
      await api().post(`/v1/notificaciones/${failed!.id}/reintentar`).set('X-Tenant-Id', TENANT).expect(202);
      await eventually(notifications, (items) => items[0]?.estado === 'ENVIADA');
      expect((await api().post(`/v1/notificaciones/${failed!.id}/reintentar`).set('X-Tenant-Id', TENANT).expect(409)).body.code).toBe(
        'NOTIFICACION_NO_REINTENTABLE',
      );
    });

    it('webhook que no responde a tiempo → TIMEOUT y reintento; se recupera al segundo intento', async () => {
      await configureWebhook().expect(201);
      webhook.responder = (_req, index) => (index === 0 ? { status: 200, delayMs: 1_500 } : { status: 200 });
      await postEvent('GUIA-0007', event()).expect(201);

      const [n] = await eventually(notifications, (items) => items[0]?.estado === 'ENVIADA');
      expect(n!.intentos).toBe(2);
      const detail = await api().get(`/v1/notificaciones/${n!.id}`).set('X-Tenant-Id', TENANT).expect(200);
      expect(detail.body.historialIntentos.map((a: { error: string | null }) => a.error)).toEqual(['TIMEOUT', null]);
    });

    it('sin webhook configurado la notificación no se pierde: termina FALLIDA y se puede reintentar luego', async () => {
      await postEvent('GUIA-0008', event()).expect(201);
      const [failed] = await eventually(() => notifications(TENANT, '?estado=FALLIDA'), (items) => items.length === 1);
      expect(failed!.ultimoError).toBe('WEBHOOK_NO_CONFIGURADO');

      await configureWebhook().expect(201);
      await api().post(`/v1/notificaciones/${failed!.id}/reintentar`).set('X-Tenant-Id', TENANT).expect(202);
      await webhook.waitFor(1);
    });
  });

  describe('Seguridad · logs sin datos personales', () => {
    it('los logs son JSON estructurado y no contienen observación, secretos ni URL del webhook', async () => {
      const { body: hook } = await configureWebhook().expect(201);
      await postEvent('GUIA-0009', event({ observacion: 'Entregado a Pepito Pérez, CC 123456789' })).expect(201);
      await webhook.waitFor(1);
      await eventually(notifications, (items) => items[0]?.estado === 'ENVIADA');

      expect(logs.lines.length).toBeGreaterThan(0);
      for (const line of logs.lines) {
        const entry = JSON.parse(line);
        expect(entry).toHaveProperty('severity');
        expect(entry).toHaveProperty('message');
      }
      expect(logs.text).not.toContain('Pepito');
      expect(logs.text).not.toContain('123456789');
      expect(logs.text).not.toContain(hook.secreto);
      expect(logs.text).not.toContain(webhookUrl);
      expect(logs.text).toContain('Intento de entrega de webhook');
    });
  });

  describe('Operación', () => {
    it('health live/ready, métricas Prometheus y OpenAPI publicados', async () => {
      await api().get('/health/live').expect(200, { status: 'ok' });
      await api().get('/health/ready').expect(200);
      const metrics = await api().get('/metrics').expect(200);
      expect(metrics.text).toContain('webhook_deliveries_total');
      expect(metrics.text).toContain('http_request_duration_seconds');
      const spec = await api().get('/docs/openapi.json').expect(200);
      expect(spec.body.openapi).toBe('3.1.0');
    });

    it('propaga X-Request-Id entrante para correlación', async () => {
      const res = await api().get('/health/live').set('X-Request-Id', 'req-e2e-12345').expect(200);
      expect(res.headers['x-request-id']).toBe('req-e2e-12345');
    });
  });
});
