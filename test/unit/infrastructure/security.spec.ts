import { AesGcmSecretCipher } from '../../../src/infrastructure/crypto/aes-gcm-secret-cipher';
import { RandomSecretGenerator } from '../../../src/infrastructure/crypto/system-adapters';
import { signWebhook, verifyWebhookSignature } from '../../../src/infrastructure/webhook/hmac-signer';
import { isBlockedAddress, NetworkWebhookDestinationPolicy } from '../../../src/infrastructure/webhook/ssrf-guard';
import { captureAsyncError } from '../../support/capture-error';
import { TEST_ENCRYPTION_KEY } from '../../support/database';

describe('Firma HMAC (Standard Webhooks)', () => {
  // Vector de ejemplo publicado por la especificación Standard Webhooks.
  const SECRET = 'whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw';
  const MSG_ID = 'msg_p5jXN8AQM9LWM0D4loKWxJek';
  const TS = 1614265330;
  const BODY = '{"test": 2432232314}';

  it('produce la firma del vector oficial', () => {
    expect(signWebhook(SECRET, MSG_ID, TS, BODY)).toBe('v1,g0hM9SsE+OTPJTGt/tmIKtSyZlE3uFJELVlNIOLJ1OE=');
  });

  it('verifica firmas válidas (también en una lista de rotación) y rechaza manipulaciones', () => {
    const sig = signWebhook(SECRET, MSG_ID, TS, BODY);
    expect(verifyWebhookSignature(SECRET, MSG_ID, TS, BODY, sig)).toBe(true);
    expect(verifyWebhookSignature(SECRET, MSG_ID, TS, BODY, `v1,otra ${sig}`)).toBe(true);
    expect(verifyWebhookSignature(SECRET, MSG_ID, TS, BODY.replace('2432', '9999'), sig)).toBe(false);
    expect(verifyWebhookSignature(SECRET, MSG_ID, TS + 1, BODY, sig)).toBe(false);
    expect(verifyWebhookSignature('whsec_b3RybyBzZWNyZXRv', MSG_ID, TS, BODY, sig)).toBe(false);
  });

  it('genera secretos whsec_ de 32 bytes aleatorios', () => {
    const generator = new RandomSecretGenerator();
    const secret = generator.generate();
    expect(secret).toMatch(/^whsec_[A-Za-z0-9+/]+=*$/);
    expect(Buffer.from(secret.slice(6), 'base64')).toHaveLength(32);
    expect(generator.generate()).not.toBe(secret);
  });
});

describe('Protección SSRF', () => {
  it.each([
    '127.0.0.1',
    '10.1.2.3',
    '172.16.0.1',
    '172.31.255.255',
    '192.168.1.1',
    '169.254.169.254', // metadata de GCP/AWS
    '100.64.0.1',
    '0.0.0.0',
    '224.0.0.1',
    '::1',
    'fe80::1',
    'fd00::1',
    '::ffff:127.0.0.1', // IPv4-mapped: no debe permitir bypass
    '::ffff:169.254.169.254',
    '64:ff9b::a9fe:a9fe', // NAT64
    'no-es-ip',
  ])('bloquea %s', (ip) => expect(isBlockedAddress(ip)).toBe(true));

  it.each(['8.8.8.8', '34.120.1.1', '172.32.0.1', '2600:1901::1'])('permite IP pública %s', (ip) => expect(isBlockedAddress(ip)).toBe(false));

  describe('política de destinos al configurar', () => {
    const strict = new NetworkWebhookDestinationPolicy({ allowPrivateNetworks: false, requireHttps: true });

    it.each([
      'http://cliente.example.com/hook', // no https
      'https://localhost/hook',
      'https://127.0.0.1/hook',
      'https://[::1]/hook',
      'https://169.254.169.254/latest/meta-data',
      'https://metadata.google.internal/computeMetadata/v1/',
    ])('rechaza %s en modo estricto', async (raw) => {
      expect((await captureAsyncError(() => strict.assertAllowed(new URL(raw)))).code).toBe('URL_WEBHOOK_NO_PERMITIDA');
    });

    it('acepta una IP pública con https', async () => {
      await expect(strict.assertAllowed(new URL('https://8.8.8.8/hook'))).resolves.toBeUndefined();
    });

    it('en desarrollo (redes privadas permitidas) acepta el receptor local de docker compose', async () => {
      const dev = new NetworkWebhookDestinationPolicy({ allowPrivateNetworks: true, requireHttps: false });
      await expect(dev.assertAllowed(new URL('http://webhook-receiver:8080/'))).resolves.toBeUndefined();
    });
  });
});

describe('Cifrado de secretos en reposo (AES-256-GCM)', () => {
  const cipher = new AesGcmSecretCipher(TEST_ENCRYPTION_KEY);

  it('cifra con IV aleatorio y descifra', () => {
    const a = cipher.encrypt('whsec_abc', 'tenant-a');
    expect(a).not.toContain('whsec_abc');
    expect(cipher.encrypt('whsec_abc', 'tenant-a')).not.toBe(a);
    expect(cipher.decrypt(a, 'tenant-a')).toBe('whsec_abc');
  });

  it('el ciphertext está ligado al tenant (AAD): no se puede mover a otro tenant', () => {
    expect(() => cipher.decrypt(cipher.encrypt('whsec_abc', 'tenant-a'), 'tenant-b')).toThrow();
  });

  it('detecta manipulación del ciphertext', () => {
    const parts = cipher.encrypt('whsec_abc', 'tenant-a').split('.');
    parts[3] = Buffer.from('xxxxxxxxx').toString('base64url');
    expect(() => cipher.decrypt(parts.join('.'), 'tenant-a')).toThrow();
  });

  it('exige una clave de 32 bytes', () => {
    expect(() => new AesGcmSecretCipher(Buffer.alloc(16).toString('base64'))).toThrow();
  });
});
