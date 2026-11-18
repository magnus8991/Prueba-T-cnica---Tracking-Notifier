import { DomainError } from '../shared/domain-error';

const MAX_URL_LENGTH = 2048;

/**
 * URL del webhook de un tenant. Reglas de forma (independientes del entorno):
 * solo http/https, sin credenciales embebidas, sin fragmento.
 * Las reglas de red (SSRF, https obligatorio) viven en un puerto de política.
 */
export class WebhookUrl {
  private constructor(
    readonly value: string,
    readonly protocol: 'http:' | 'https:',
    readonly hostname: string,
  ) {}

  static create(raw: string): WebhookUrl {
    if (typeof raw !== 'string' || raw.length === 0 || raw.length > MAX_URL_LENGTH) {
      throw new DomainError('URL_WEBHOOK_INVALIDA', `La URL es obligatoria y admite máximo ${MAX_URL_LENGTH} caracteres`);
    }
    let parsed: URL;
    try {
      parsed = new URL(raw);
    } catch {
      throw new DomainError('URL_WEBHOOK_INVALIDA', 'La URL del webhook no es válida');
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new DomainError('URL_WEBHOOK_INVALIDA', 'La URL del webhook debe usar http o https');
    }
    if (parsed.username !== '' || parsed.password !== '') {
      throw new DomainError('URL_WEBHOOK_INVALIDA', 'La URL del webhook no puede contener credenciales');
    }
    if (parsed.hash !== '') {
      throw new DomainError('URL_WEBHOOK_INVALIDA', 'La URL del webhook no puede contener fragmento (#)');
    }
    return new WebhookUrl(parsed.toString(), parsed.protocol, parsed.hostname);
  }
}
