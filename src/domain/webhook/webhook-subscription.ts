import { TenantId } from '../tenant/tenant-id';
import { WebhookUrl } from './webhook-url';

export interface WebhookSubscriptionProps {
  tenantId: TenantId;
  url: WebhookUrl;
  /** Secreto HMAC en claro dentro del dominio; el adaptador de persistencia lo cifra en reposo. */
  secret: string;
  createdAt: Date;
  updatedAt: Date;
}

/** Configuración del webhook de un tenant (uno por tenant). */
export class WebhookSubscription {
  private constructor(private props: WebhookSubscriptionProps) {}

  static create(params: { tenantId: TenantId; url: WebhookUrl; secret: string; now: Date }): WebhookSubscription {
    return new WebhookSubscription({
      tenantId: params.tenantId,
      url: params.url,
      secret: params.secret,
      createdAt: params.now,
      updatedAt: params.now,
    });
  }

  static restore(props: WebhookSubscriptionProps): WebhookSubscription {
    return new WebhookSubscription({ ...props });
  }

  get tenantId(): TenantId {
    return this.props.tenantId;
  }
  get url(): WebhookUrl {
    return this.props.url;
  }
  get secret(): string {
    return this.props.secret;
  }
  get createdAt(): Date {
    return this.props.createdAt;
  }
  get updatedAt(): Date {
    return this.props.updatedAt;
  }

  changeUrl(url: WebhookUrl, now: Date): void {
    this.props = { ...this.props, url, updatedAt: now };
  }

  rotateSecret(secret: string, now: Date): void {
    this.props = { ...this.props, secret, updatedAt: now };
  }
}
