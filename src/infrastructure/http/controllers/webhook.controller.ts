import { Body, Controller, Get, Put, Res } from '@nestjs/common';
import { Response } from 'express';
import { ConfigureWebhook, GetWebhook } from '../../../application/use-cases/configure-webhook';
import { presentWebhook } from '../presenters';
import { ConfigureWebhookBody, configureWebhookBodySchema } from '../schemas';
import { TenantHeader, ZodValidationPipe } from '../validation';

/** Adaptador HTTP de entrada para RF3 (configurar webhook del cliente). */
@Controller('v1/webhook')
export class WebhookController {
  constructor(
    private readonly configureWebhook: ConfigureWebhook,
    private readonly getWebhook: GetWebhook,
  ) {}

  @Put()
  async configure(
    @TenantHeader() tenantId: string,
    @Body(new ZodValidationPipe(configureWebhookBodySchema)) body: ConfigureWebhookBody,
    @Res({ passthrough: true }) res: Response,
  ) {
    const result = await this.configureWebhook.execute({ tenantId, url: body.url, rotateSecret: body.rotarSecreto });
    res.status(result.created ? 201 : 200);
    return presentWebhook(result.subscription, result.revealedSecret);
  }

  @Get()
  async get(@TenantHeader() tenantId: string) {
    return presentWebhook(await this.getWebhook.execute({ tenantId }));
  }
}
