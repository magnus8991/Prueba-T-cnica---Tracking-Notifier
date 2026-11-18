import { ApplicationError, NotFoundError } from '../../../src/application/errors';
import { WebhookDestinationPolicy } from '../../../src/application/ports/webhook-sender';
import { ConfigureWebhook, GetWebhook } from '../../../src/application/use-cases/configure-webhook';
import { GetShipmentHistory } from '../../../src/application/use-cases/get-shipment-history';
import { GetNotification, ListNotifications, RetryNotification } from '../../../src/application/use-cases/notification-queries';
import { RegisterTrackingEvent } from '../../../src/application/use-cases/register-tracking-event';
import { TenantId } from '../../../src/domain/tenant/tenant-id';
import { captureAsyncError } from '../../support/capture-error';
import { AllowAllDestinations, FakeSecrets, FixedClock, InMemoryDatabase, InMemorySubscriptions, SequentialIds, SpyWorkSignal } from '../../support/in-memory';

describe('Consultas y configuración', () => {
  let db: InMemoryDatabase;
  let register: RegisterTrackingEvent;
  const clock = new FixedClock();

  const event = (eventId: string, status: string, occurredAt: string, tenantId = 'tenant-a') =>
    register.execute({ tenantId, trackingNumber: 'GUIA-0001', eventId, status, occurredAt: new Date(occurredAt), observation: null });

  beforeEach(() => {
    db = new InMemoryDatabase();
    register = new RegisterTrackingEvent(db, clock, new SequentialIds(), new SpyWorkSignal(), 5);
  });

  describe('GetShipmentHistory (RF2)', () => {
    it('devuelve el estado actual y los eventos en orden cronológico aunque lleguen desordenados', async () => {
      await event('00000000-0000-4000-8000-000000000003', 'EN_RUTA', '2026-11-01T12:00:00Z');
      await event('00000000-0000-4000-8000-000000000001', 'CREADA', '2026-11-01T08:00:00Z');
      await event('00000000-0000-4000-8000-000000000002', 'EN_RUTA', '2026-11-01T10:00:00Z');

      const history = await new GetShipmentHistory(db.shipments, db.events).execute({ tenantId: 'tenant-a', trackingNumber: 'GUIA-0001' });

      expect(history.shipment.currentStatus).toBe('EN_RUTA');
      expect(history.events.map((e) => e.eventId.value.slice(-1))).toEqual(['1', '2', '3']);
    });

    it('un tenant nunca ve guías de otro tenant: responde como inexistente', async () => {
      await event('00000000-0000-4000-8000-000000000001', 'CREADA', '2026-11-01T08:00:00Z', 'tenant-a');
      const error = await captureAsyncError(() =>
        new GetShipmentHistory(db.shipments, db.events).execute({ tenantId: 'tenant-b', trackingNumber: 'GUIA-0001' }),
      );
      expect(error).toBeInstanceOf(NotFoundError);
      expect(error.message).toBe('Guía no encontrada');
    });
  });

  describe('ConfigureWebhook (RF3)', () => {
    const setup = (policy: WebhookDestinationPolicy = new AllowAllDestinations()) => {
      const subs = new InMemorySubscriptions();
      return { subs, configure: new ConfigureWebhook(subs, policy, new FakeSecrets(), clock), get: new GetWebhook(subs) };
    };

    it('crea la configuración y revela el secreto una única vez', async () => {
      const { configure, get } = setup();
      const created = await configure.execute({ tenantId: 'tenant-a', url: 'https://cliente.example.com/hook', rotateSecret: false });
      expect(created).toMatchObject({ created: true, revealedSecret: 'whsec_fake1' });

      const updated = await configure.execute({ tenantId: 'tenant-a', url: 'https://cliente.example.com/v2', rotateSecret: false });
      expect(updated).toMatchObject({ created: false, revealedSecret: null });
      expect((await get.execute({ tenantId: 'tenant-a' })).url.value).toBe('https://cliente.example.com/v2');
      expect(updated.subscription.secret).toBe('whsec_fake1');
    });

    it('rota el secreto solo cuando se pide', async () => {
      const { configure } = setup();
      await configure.execute({ tenantId: 'tenant-a', url: 'https://cliente.example.com/hook', rotateSecret: false });
      const rotated = await configure.execute({ tenantId: 'tenant-a', url: 'https://cliente.example.com/hook', rotateSecret: true });
      expect(rotated.revealedSecret).toBe('whsec_fake2');
    });

    it('aplica la política de destinos (anti-SSRF) antes de guardar', async () => {
      const deny: WebhookDestinationPolicy = {
        assertAllowed: async () => {
          throw new ApplicationError('URL_WEBHOOK_NO_PERMITIDA', 'no');
        },
      };
      const { configure, subs } = setup(deny);
      const error = await captureAsyncError(() => configure.execute({ tenantId: 'tenant-a', url: 'http://169.254.169.254/', rotateSecret: false }));
      expect(error.code).toBe('URL_WEBHOOK_NO_PERMITIDA');
      expect(await subs.find(TenantId.create('tenant-a'))).toBeNull();
    });

    it('GET de un tenant sin webhook responde no encontrado', async () => {
      expect(await captureAsyncError(() => setup().get.execute({ tenantId: 'tenant-z' }))).toBeInstanceOf(NotFoundError);
    });
  });

  describe('Notificaciones', () => {
    it('lista solo las del tenant y filtra por estado', async () => {
      await event('00000000-0000-4000-8000-000000000001', 'CREADA', '2026-11-01T08:00:00Z', 'tenant-a');
      await event('00000000-0000-4000-8000-000000000002', 'CREADA', '2026-11-01T08:00:00Z', 'tenant-b');
      const list = new ListNotifications(db.notifications);

      expect(await list.execute({ tenantId: 'tenant-a' })).toHaveLength(1);
      expect(await list.execute({ tenantId: 'tenant-a', status: 'FALLIDA' })).toHaveLength(0);
    });

    it('el detalle de una notificación de otro tenant no es visible', async () => {
      await event('00000000-0000-4000-8000-000000000001', 'CREADA', '2026-11-01T08:00:00Z', 'tenant-a');
      const id = db.allNotifications[0]!.id;
      const get = new GetNotification(db.notifications);
      await expect(get.execute({ tenantId: 'tenant-a', id })).resolves.toBeDefined();
      expect(await captureAsyncError(() => get.execute({ tenantId: 'tenant-b', id }))).toBeInstanceOf(NotFoundError);
    });

    it('solo se reintenta manualmente una notificación FALLIDA', async () => {
      await event('00000000-0000-4000-8000-000000000001', 'CREADA', '2026-11-01T08:00:00Z');
      const id = db.allNotifications[0]!.id;
      const retry = new RetryNotification(db.notifications, clock, new SpyWorkSignal());
      expect((await captureAsyncError(() => retry.execute({ tenantId: 'tenant-a', id }))).code).toBe('NOTIFICACION_NO_REINTENTABLE');
    });
  });
});
