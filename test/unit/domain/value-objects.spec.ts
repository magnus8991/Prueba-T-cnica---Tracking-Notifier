import { EventId } from '../../../src/domain/shipment/event-id';
import { isTerminalStatus, parseShipmentStatus } from '../../../src/domain/shipment/shipment-status';
import { TrackingNumber } from '../../../src/domain/shipment/tracking-number';
import { TenantId } from '../../../src/domain/tenant/tenant-id';
import { WebhookUrl } from '../../../src/domain/webhook/webhook-url';
import { captureError } from '../../support/capture-error';

describe('Value objects', () => {
  describe('TenantId', () => {
    it.each(['tenant-a', 'BANCO_1', 'a'])('acepta %s', (raw) => expect(TenantId.create(raw).value).toBe(raw));
    it.each(['', 'con espacio', 'x'.repeat(65), "t';drop", '../etc'])('rechaza %p', (raw) =>
      expect(captureError(() => TenantId.create(raw)).code).toBe('TENANT_INVALIDO'),
    );
  });

  describe('TrackingNumber', () => {
    it('acepta alfanuméricos y guiones', () => expect(TrackingNumber.create('GUIA-0001').value).toBe('GUIA-0001'));
    it.each(['', 'G 1', 'x'.repeat(41), 'G/1'])('rechaza %p', (raw) =>
      expect(captureError(() => TrackingNumber.create(raw)).code).toBe('NUMERO_GUIA_INVALIDO'),
    );
  });

  describe('EventId', () => {
    it('normaliza a minúsculas para que la idempotencia no dependa del formato', () => {
      expect(EventId.create('9F1C2D3E-1111-4222-8333-444455556666').value).toBe('9f1c2d3e-1111-4222-8333-444455556666');
    });
    it.each(['', 'no-uuid', '9f1c2d3e11114222833344445555666'])('rechaza %p', (raw) =>
      expect(captureError(() => EventId.create(raw)).code).toBe('EVENT_ID_INVALIDO'),
    );
  });

  describe('ShipmentStatus', () => {
    it('solo ENTREGADA y DEVUELTA son terminales', () => {
      expect(['CREADA', 'EN_RUTA', 'ENTREGADA', 'DEVUELTA'].map((s) => isTerminalStatus(parseShipmentStatus(s)))).toEqual([
        false,
        false,
        true,
        true,
      ]);
    });
    it('rechaza estados desconocidos (sensible a mayúsculas)', () => {
      expect(captureError(() => parseShipmentStatus('entregada')).code).toBe('ESTADO_INVALIDO');
      expect(captureError(() => parseShipmentStatus('PERDIDA')).code).toBe('ESTADO_INVALIDO');
    });
  });

  describe('WebhookUrl', () => {
    it('acepta http y https', () => {
      expect(WebhookUrl.create('https://cliente.example.com/hooks/guias?x=1').hostname).toBe('cliente.example.com');
      expect(WebhookUrl.create('http://webhook-receiver:8080/').protocol).toBe('http:');
    });
    it.each([
      ['esquema no permitido', 'ftp://example.com/x'],
      ['file', 'file:///etc/passwd'],
      ['credenciales embebidas', 'https://user:pass@example.com/'],
      ['fragmento', 'https://example.com/#x'],
      ['no es URL', 'not a url'],
      ['vacía', ''],
      ['demasiado larga', `https://example.com/${'a'.repeat(2050)}`],
    ])('rechaza %s', (_case, raw) => expect(captureError(() => WebhookUrl.create(raw)).code).toBe('URL_WEBHOOK_INVALIDA'));
  });
});
