import { createHmac, timingSafeEqual } from 'node:crypto';

const SECRET_PREFIX = 'whsec_';

function secretKey(secret: string): Buffer {
  return secret.startsWith(SECRET_PREFIX) ? Buffer.from(secret.slice(SECRET_PREFIX.length), 'base64') : Buffer.from(secret, 'utf8');
}

/**
 * Firma según Standard Webhooks (https://www.standardwebhooks.com):
 *   webhook-signature: v1,<base64(HMAC-SHA256(key, `${id}.${timestamp}.${body}`))>
 */
export function signWebhook(secret: string, messageId: string, timestampSeconds: number, body: string): string {
  const digest = createHmac('sha256', secretKey(secret)).update(`${messageId}.${timestampSeconds}.${body}`).digest('base64');
  return `v1,${digest}`;
}

/** Verificación en tiempo constante (la usa el receptor de prueba y documenta cómo verificar del lado cliente). */
export function verifyWebhookSignature(secret: string, messageId: string, timestampSeconds: number, body: string, header: string): boolean {
  const expected = Buffer.from(signWebhook(secret, messageId, timestampSeconds, body));
  return header.split(' ').some((candidate) => {
    const received = Buffer.from(candidate);
    return received.length === expected.length && timingSafeEqual(received, expected);
  });
}
