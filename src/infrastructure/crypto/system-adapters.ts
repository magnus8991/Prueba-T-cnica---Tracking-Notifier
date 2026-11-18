import { randomBytes, randomUUID } from 'node:crypto';
import { Clock, IdGenerator, SecretGenerator } from '../../application/ports/system';

export class SystemClock implements Clock {
  now(): Date {
    return new Date();
  }
}

export class CryptoIdGenerator implements IdGenerator {
  uuid(): string {
    return randomUUID();
  }
}

/** Secreto con formato Standard Webhooks: whsec_ + base64(32 bytes CSPRNG). */
export class RandomSecretGenerator implements SecretGenerator {
  generate(): string {
    return `whsec_${randomBytes(32).toString('base64')}`;
  }
}
