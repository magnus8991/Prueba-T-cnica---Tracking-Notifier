import { WebhookSubscriptionRepository } from '../../../application/ports/repositories';
import { TenantId } from '../../../domain/tenant/tenant-id';
import { WebhookSubscription } from '../../../domain/webhook/webhook-subscription';
import { WebhookUrl } from '../../../domain/webhook/webhook-url';
import { SecretCipher } from '../../crypto/aes-gcm-secret-cipher';
import { Queryable } from '../pg-pool';

interface SubscriptionRow {
  tenant_id: string;
  url: string;
  secret_ciphertext: string;
  created_at: Date;
  updated_at: Date;
}

/** El secreto HMAC se cifra al guardar y se descifra al leer: nunca queda en claro en la BD. */
export class PgWebhookSubscriptionRepository implements WebhookSubscriptionRepository {
  constructor(
    private readonly db: Queryable,
    private readonly cipher: SecretCipher,
  ) {}

  async find(tenantId: TenantId): Promise<WebhookSubscription | null> {
    const { rows } = await this.db.query<SubscriptionRow>(
      'SELECT tenant_id, url, secret_ciphertext, created_at, updated_at FROM webhook_subscriptions WHERE tenant_id = $1',
      [tenantId.value],
    );
    const row = rows[0];
    return row
      ? WebhookSubscription.restore({
          tenantId: TenantId.create(row.tenant_id),
          url: WebhookUrl.create(row.url),
          secret: this.cipher.decrypt(row.secret_ciphertext, row.tenant_id),
          createdAt: row.created_at,
          updatedAt: row.updated_at,
        })
      : null;
  }

  async save(subscription: WebhookSubscription): Promise<void> {
    await this.db.query(
      `INSERT INTO webhook_subscriptions (tenant_id, url, secret_ciphertext, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (tenant_id)
       DO UPDATE SET url = EXCLUDED.url, secret_ciphertext = EXCLUDED.secret_ciphertext, updated_at = EXCLUDED.updated_at`,
      [
        subscription.tenantId.value,
        subscription.url.value,
        this.cipher.encrypt(subscription.secret, subscription.tenantId.value),
        subscription.createdAt,
        subscription.updatedAt,
      ],
    );
  }
}
