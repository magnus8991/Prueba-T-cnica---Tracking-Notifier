import { WebhookDelivery } from '../../src/application/ports/webhook-sender';
import { verifyWebhookSignature } from '../../src/infrastructure/webhook/hmac-signer';
import { HttpWebhookSender } from '../../src/infrastructure/webhook/http-webhook-sender';
import { FakeWebhookServer } from '../support/fake-webhook-server';

describe('HttpWebhookSender (HTTP real contra servidor local)', () => {
  const server = new FakeWebhookServer();
  let url: string;
  const sender = new HttpWebhookSender({ timeoutMs: 300, allowPrivateNetworks: true, userAgent: 'tracking-notifier-test' }, () => 1_700_000_000);
  const delivery = (overrides: Partial<WebhookDelivery> = {}): WebhookDelivery => ({
    url,
    secret: 'whsec_dGVzdC1zZWNyZXQtZm9yLWhtYWMtMzJieXRlcyE=',
    messageId: '11111111-1111-4111-8111-111111111111',
    attempt: 2,
    payload: { type: 'guia.estado_actualizado', estado: 'EN_RUTA' },
    ...overrides,
  });

  beforeAll(async () => {
    url = await server.start();
  });
  afterAll(() => server.stop());
  beforeEach(() => {
    server.received.length = 0;
    server.responder = () => ({ status: 200 });
  });

  it('envía POST JSON con cabeceras Standard Webhooks y firma verificable', async () => {
    const result = await sender.send(delivery());
    expect(result).toMatchObject({ ok: true, httpStatus: 200 });

    const [req] = server.received;
    expect(req!.headers).toMatchObject({
      'content-type': 'application/json',
      'webhook-id': '11111111-1111-4111-8111-111111111111',
      'webhook-timestamp': '1700000000',
      'x-delivery-attempt': '2',
    });
    expect(JSON.parse(req!.body)).toEqual({ type: 'guia.estado_actualizado', estado: 'EN_RUTA' });
    expect(verifyWebhookSignature(delivery().secret, '11111111-1111-4111-8111-111111111111', 1_700_000_000, req!.body, req!.headers['webhook-signature'] as string)).toBe(
      true,
    );
  });

  it('cualquier 2xx es éxito', async () => {
    server.responder = () => ({ status: 204 });
    expect(await sender.send(delivery())).toMatchObject({ ok: true, httpStatus: 204 });
  });

  it.each([400, 404, 500, 503])('HTTP %i es fallo reintentable', async (status) => {
    server.responder = () => ({ status });
    expect(await sender.send(delivery())).toMatchObject({ ok: false, errorCode: 'HTTP_ERROR', httpStatus: status });
  });

  it('NO sigue redirecciones (302 = fallo, protección SSRF)', async () => {
    server.responder = () => ({ status: 302, headers: { location: 'http://169.254.169.254/' } });
    expect(await sender.send(delivery())).toMatchObject({ ok: false, errorCode: 'HTTP_ERROR', httpStatus: 302 });
    expect(server.received).toHaveLength(1);
  });

  it('si el webhook no responde dentro del timeout devuelve TIMEOUT', async () => {
    server.responder = () => ({ status: 200, delayMs: 2_000 });
    const result = await sender.send(delivery());
    expect(result).toMatchObject({ ok: false, errorCode: 'TIMEOUT', httpStatus: null });
    expect(result.durationMs).toBeGreaterThanOrEqual(290);
    expect(result.durationMs).toBeLessThan(1_500);
  });

  it('conexión rechazada → NETWORK_ERROR', async () => {
    expect(await sender.send(delivery({ url: 'http://127.0.0.1:1/hook' }))).toMatchObject({ ok: false, errorCode: 'NETWORK_ERROR' });
  });

  describe('modo estricto (producción)', () => {
    const strict = new HttpWebhookSender({ timeoutMs: 300, allowPrivateNetworks: false, userAgent: 'x' });

    it('bloquea IPs privadas literales sin conectar', async () => {
      expect(await strict.send(delivery())).toMatchObject({ ok: false, errorCode: 'DESTINO_NO_PERMITIDO' });
      expect(server.received).toHaveLength(0);
    });

    it('bloquea hostnames que resuelven a loopback (validación en el lookup de conexión)', async () => {
      const viaHostname = url.replace('127.0.0.1', 'localhost');
      expect(await strict.send(delivery({ url: viaHostname }))).toMatchObject({ ok: false, errorCode: 'DESTINO_NO_PERMITIDO' });
      expect(server.received).toHaveLength(0);
    });
  });
});
