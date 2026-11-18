import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

export interface SecretCipher {
  /** `context` (p.ej. tenantId) se usa como AAD: un ciphertext no puede moverse a otro tenant. */
  encrypt(plaintext: string, context: string): string;
  decrypt(ciphertext: string, context: string): string;
}

const VERSION = 'v1';
const IV_BYTES = 12; // recomendado por NIST SP 800-38D para GCM

/** Cifrado autenticado AES-256-GCM. Formato: v1.<iv>.<tag>.<ciphertext> (base64url). */
export class AesGcmSecretCipher implements SecretCipher {
  private readonly key: Buffer;

  constructor(base64Key: string) {
    const key = Buffer.from(base64Key, 'base64');
    if (key.length !== 32) {
      throw new Error('La clave de cifrado debe ser de 32 bytes codificada en base64');
    }
    this.key = key;
  }

  encrypt(plaintext: string, context: string): string {
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    cipher.setAAD(Buffer.from(context, 'utf8'));
    const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    return [VERSION, iv.toString('base64url'), cipher.getAuthTag().toString('base64url'), ciphertext.toString('base64url')].join('.');
  }

  decrypt(payload: string, context: string): string {
    const [version, iv, tag, ciphertext] = payload.split('.');
    if (version !== VERSION || !iv || !tag || ciphertext === undefined) {
      throw new Error('Formato de secreto cifrado no soportado');
    }
    const decipher = createDecipheriv('aes-256-gcm', this.key, Buffer.from(iv, 'base64url'));
    decipher.setAAD(Buffer.from(context, 'utf8'));
    decipher.setAuthTag(Buffer.from(tag, 'base64url'));
    return Buffer.concat([decipher.update(Buffer.from(ciphertext, 'base64url')), decipher.final()]).toString('utf8');
  }
}
