import { Body, Controller, Get, HttpCode, Param, Post, Res } from '@nestjs/common';
import { Response } from 'express';
import { GetShipmentHistory } from '../../../application/use-cases/get-shipment-history';
import { RegisterTrackingEvent } from '../../../application/use-cases/register-tracking-event';
import { PrometheusMetrics } from '../../observability/metrics';
import { presentHistory, presentRegisteredEvent } from '../presenters';
import { RegisterEventBody, registerEventBodySchema, trackingNumberParamSchema } from '../schemas';
import { TenantHeader, ZodValidationPipe } from '../validation';

/** Adaptador HTTP de entrada para RF1 (registrar evento) y RF2 (historial). */
@Controller('v1/guias')
export class ShipmentsController {
  constructor(
    private readonly registerTrackingEvent: RegisterTrackingEvent,
    private readonly getShipmentHistory: GetShipmentHistory,
    private readonly metrics: PrometheusMetrics,
  ) {}

  @Post(':numeroGuia/eventos')
  @HttpCode(201)
  async register(
    @TenantHeader() tenantId: string,
    @Param('numeroGuia', new ZodValidationPipe(trackingNumberParamSchema, 'numeroGuia')) trackingNumber: string,
    @Body(new ZodValidationPipe(registerEventBodySchema)) body: RegisterEventBody,
    @Res({ passthrough: true }) res: Response,
  ) {
    const result = await this.registerTrackingEvent.execute({
      tenantId,
      trackingNumber,
      eventId: body.eventId,
      status: body.estado,
      occurredAt: new Date(body.fechaEvento),
      observation: body.observacion ?? null,
    });

    this.metrics.trackingEvents.inc({ result: result.outcome === 'CREATED' ? 'creado' : 'repetido' });
    res.setHeader('Location', `/v1/guias/${encodeURIComponent(trackingNumber)}`);
    if (result.outcome === 'REPLAYED') {
      // Idempotencia: misma respuesta funcional, sin efectos nuevos.
      res.status(200).setHeader('Idempotent-Replayed', 'true');
    }
    return presentRegisteredEvent(result.event, result.shipment.snapshot());
  }

  @Get(':numeroGuia')
  async history(
    @TenantHeader() tenantId: string,
    @Param('numeroGuia', new ZodValidationPipe(trackingNumberParamSchema, 'numeroGuia')) trackingNumber: string,
  ) {
    return presentHistory(await this.getShipmentHistory.execute({ tenantId, trackingNumber }));
  }
}
