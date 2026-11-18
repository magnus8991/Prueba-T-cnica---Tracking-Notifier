import { TenantId } from '../../domain/tenant/tenant-id';
import { WebhookSubscription } from '../../domain/webhook/webhook-subscription';
import { WebhookUrl } from '../../domain/webhook/webhook-url';
import { NotFoundError } from '../errors';
import { WebhookSubscriptionRepository } from '../ports/repositories';
import { Clock, SecretGenerator } from '../ports/system';
import { WebhookDestinationPolicy } from '../ports/webhook-sender';

export interface ConfigureWebhookResult {
  subscription: WebhookSubscription;
  created: boolean;
  /** El secreto solo se revela al crearse o rotarse; después no vuelve a exponerse. */
  revealedSecret: string | null;
}

/** RF3: guarda (crea o actualiza) la URL de notificación del tenant. */
export class ConfigureWebhook {
  constructor(
    private readonly subscriptions: WebhookSubscriptionRepository,
    private readonly destinationPolicy: WebhookDestinationPolicy,
    private readonly secrets: SecretGenerator,
    private readonly clock: Clock,
  ) {}

  async execute(command: { tenantId: string; url: string; rotateSecret: boolean }): Promise<ConfigureWebhookResult> {
    const tenantId = TenantId.create(command.tenantId);
    const url = WebhookUrl.create(command.url);
    await this.destinationPolicy.assertAllowed(new URL(url.value));
    const now = this.clock.now();

    let existing = await this.subscriptions.find(tenantId);
    if (!existing) {
      const secret = this.secrets.generate();
      const subscription = WebhookSubscription.create({ tenantId, url, secret, now });
      // Atómico: si dos PUT concurrentes crean a la vez, solo uno revela secreto (el otro actualiza).
      if (await this.subscriptions.insertIfAbsent(subscription)) {
        return { subscription, created: true, revealedSecret: secret };
      }
      existing = (await this.subscriptions.find(tenantId))!;
    }

    existing.changeUrl(url, now);
    let revealedSecret: string | null = null;
    if (command.rotateSecret) {
      revealedSecret = this.secrets.generate();
      existing.rotateSecret(revealedSecret, now);
    }
    await this.subscriptions.save(existing);
    return { subscription: existing, created: false, revealedSecret };
  }
}

export class GetWebhook {
  constructor(private readonly subscriptions: WebhookSubscriptionRepository) {}

  async execute(query: { tenantId: string }): Promise<WebhookSubscription> {
    const subscription = await this.subscriptions.find(TenantId.create(query.tenantId));
    if (!subscription) {
      throw new NotFoundError('Webhook');
    }
    return subscription;
  }
}
