import { request as httpRequest, RequestOptions } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { isIP } from 'node:net';
import { performance } from 'node:perf_hooks';
import { DeliveryErrorCode, DeliveryResult, WebhookDelivery, WebhookSender } from '../../application/ports/webhook-sender';
import { signWebhook } from './hmac-signer';
import { createGuardedLookup, isBlockedAddress } from './ssrf-guard';

export interface HttpWebhookSenderSettings {
  timeoutMs: number;
  allowPrivateNetworks: boolean;
  userAgent: string;
}

/**
 * Adaptador HTTP del puerto WebhookSender (node:http/https, sin dependencias).
 *  - Timeout total por intento (por defecto 5 s, requisito RF4).
 *  - NO sigue redirecciones (3xx = fallo): evita SSRF por redirect.
 *  - No lee el cuerpo de la respuesta (solo el status): evita consumo de memoria.
 *  - Nunca lanza: traduce todo a DeliveryResult.
 */
export class HttpWebhookSender implements WebhookSender {
  private readonly lookup;

  constructor(
    private readonly settings: HttpWebhookSenderSettings,
    private readonly nowSeconds: () => number = () => Math.floor(Date.now() / 1000),
  ) {
    this.lookup = createGuardedLookup(settings.allowPrivateNetworks);
  }

  async send(delivery: WebhookDelivery): Promise<DeliveryResult> {
    const startedAt = performance.now();
    const elapsed = () => Math.round(performance.now() - startedAt);
    const fail = (errorCode: DeliveryErrorCode, httpStatus: number | null = null): DeliveryResult => ({
      ok: false,
      errorCode,
      httpStatus,
      durationMs: elapsed(),
    });

    let url: URL;
    try {
      url = new URL(delivery.url);
    } catch {
      return fail('DESTINO_NO_PERMITIDO');
    }
    const literalHost = url.hostname.replace(/^\[|\]$/g, '');
    if (!this.settings.allowPrivateNetworks && isIP(literalHost) !== 0 && isBlockedAddress(literalHost)) {
      return fail('DESTINO_NO_PERMITIDO'); // con IP literal, Node no invoca lookup: se valida aquí
    }

    const body = JSON.stringify(delivery.payload);
    const timestamp = this.nowSeconds();
    const options: RequestOptions = {
      method: 'POST',
      lookup: this.lookup as RequestOptions['lookup'],
      headers: {
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(body),
        'user-agent': this.settings.userAgent,
        'webhook-id': delivery.messageId,
        'webhook-timestamp': String(timestamp),
        'webhook-signature': signWebhook(delivery.secret, delivery.messageId, timestamp, body),
        'x-delivery-attempt': String(delivery.attempt),
      },
    };
    const doRequest = url.protocol === 'https:' ? httpsRequest : httpRequest;

    return new Promise<DeliveryResult>((resolve) => {
      let settled = false;
      const finish = (result: DeliveryResult) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(result);
      };

      const req = doRequest(url, options, (res) => {
        const status = res.statusCode ?? 0;
        res.destroy(); // solo interesa el status
        finish(status >= 200 && status < 300 ? { ok: true, httpStatus: status, durationMs: elapsed() } : fail('HTTP_ERROR', status));
      });

      const timer = setTimeout(() => {
        finish(fail('TIMEOUT'));
        req.destroy();
      }, this.settings.timeoutMs);

      req.on('error', (error: NodeJS.ErrnoException) => {
        finish(fail(error.code === 'DESTINO_NO_PERMITIDO' ? 'DESTINO_NO_PERMITIDO' : 'NETWORK_ERROR'));
      });
      req.end(body);
    });
  }
}
